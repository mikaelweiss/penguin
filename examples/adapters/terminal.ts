import { adapter } from "wa";
import type { ViewEvent } from "wa";

function elapsed(millis: number): string {
  const seconds = Math.floor(millis / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m${seconds % 60}s`;
  return `${hours}h${minutes % 60}m`;
}

export default adapter({
  role: "view",
  name: "terminal",
  description: "renders run events as terminal lines, with a live footer on a TTY",
  build: (host) => {
    const tty = process.stdout.isTTY === true;
    const facts: Record<string, string | number | boolean> = {};
    const sessions = new Map<string, string>();
    let watching: { elapsed?: boolean; diff?: string } | undefined;
    let started = Date.now();
    let diffStat = "";
    let state = "";
    let detail = "";
    let timer: ReturnType<typeof setInterval> | undefined;

    const footer = (): string => {
      const parts: string[] = [];
      if (state !== "") parts.push(detail === "" ? state : `${state}: ${detail}`);
      if (watching?.elapsed === true) parts.push(elapsed(Date.now() - started));
      if (diffStat !== "") parts.push(diffStat);
      for (const [name, value] of Object.entries(facts)) parts.push(`${name} ${value}`);
      return parts.join("  ");
    };
    const redraw = (): void => {
      if (tty) process.stdout.write(`\r\x1b[2K${footer()}`);
    };
    const print = (line: string): void => {
      if (tty) process.stdout.write(`\r\x1b[2K${line}\n`);
      else process.stdout.write(`${line}\n`);
      redraw();
    };
    const sample = async (): Promise<void> => {
      if (watching?.diff !== undefined) {
        const done = await host.shell("git diff --shortstat", { cwd: watching.diff });
        diffStat = done.code === 0 ? done.stdout.trim() : "";
      }
      redraw();
    };
    const start = (): void => {
      if (!tty || timer !== undefined) return;
      timer = setInterval(() => {
        void sample();
      }, 1000);
      timer.unref();
    };
    const stop = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (tty) process.stdout.write("\r\x1b[2K");
    };
    const speaker = (id: string): string => {
      const name = sessions.get(id);
      if (name === undefined || sessions.size < 2) return "";
      return `[${name}] `;
    };

    return {
      render(event: ViewEvent): void {
        switch (event.type) {
          case "run":
            if (event.phase !== "started") stop();
            return;
          case "state":
            state = event.state;
            detail = event.detail ?? "";
            redraw();
            return;
          case "session":
            sessions.set(event.id, event.name);
            return;
          case "message":
            print(`> ${event.text}`);
            return;
          case "gate":
            if (event.phase === "asked") {
              print("");
              print(`gate: ${event.question}`);
            }
            return;
          case "watch":
            watching = event;
            started = Date.now();
            start();
            redraw();
            return;
          case "fact":
            Object.assign(facts, event.values);
            if (tty) redraw();
            else {
              const line = Object.entries(event.values)
                .map(([name, value]) => `${name}: ${value}`)
                .join("  ");
              print(line);
            }
            return;
          case "step":
            if (event.phase === "start") print(`step ${event.id} ${event.label}`);
            return;
          case "activity":
            if (event.phase === "start") print(event.label);
            return;
          case "event":
            print(event.level === "info" ? event.message : `${event.level}: ${event.message}`);
            return;
          case "artifact": {
            const where = event.path ?? event.url;
            print(where === undefined ? `artifact: ${event.title}` : `artifact: ${event.title} (${where})`);
            return;
          }
          case "agent":
            if (event.kind === "output") process.stdout.write(event.text);
            else print(`${speaker(event.session)}${event.kind === "tool" ? `[${event.text}]` : event.text}`);
            return;
          default:
            return;
        }
      },
    };
  },
});
