import { adapter, cut, markdown } from "penguin";
import type { ViewEvent } from "penguin";

const WIDEST = 100;

export default adapter({
  role: "view",
  name: "terminal",
  description: "renders run events as terminal lines, with markdown read as markdown",
  build: () => {
    const tty = process.stdout.isTTY === true;
    const sessions = new Map<string, string>();
    let partial = "";

    const columns = (): number => Math.max(20, process.stdout.columns ?? 80);
    const width = (): number => Math.min(WIDEST, columns());
    const print = (line: string): void => {
      process.stdout.write(`${line}\n`);
    };
    const dim = (text: string): string => (tty ? `\x1b[2m${text}\x1b[22m` : text);
    const bold = (text: string): string => (tty ? `\x1b[1m${text}\x1b[22m` : text);
    /** Prose the model wrote: markdown on a terminal, the text itself anywhere else. */
    const say = (text: string): void => {
      if (!tty) {
        print(text);
        return;
      }
      for (const line of markdown(text, width())) print(line);
    };
    const rule = (label: string): string => {
      const bar = "─".repeat(Math.max(0, width() - label.length - 4));
      return dim(`── ${label} ${bar}`);
    };
    const flush = (): void => {
      if (partial === "") return;
      print(partial);
      partial = "";
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
            if (event.phase !== "started") flush();
            return;
          case "session":
            sessions.set(event.id, event.name);
            return;
          case "message":
            print(`> ${event.text}`);
            return;
          case "gate":
            if (event.phase !== "asked") return;
            print("");
            print(rule("gate"));
            say(event.question);
            print("");
            return;
          case "fact":
            print(
              Object.entries(event.values)
                .map(([name, value]) => `${name}: ${value}`)
                .join("  "),
            );
            return;
          case "step":
            if (event.phase === "start") print(`step ${event.id} ${event.label}`);
            return;
          case "activity":
            if (event.phase === "start") print(bold(event.label));
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
            if (event.kind === "output") {
              partial += event.text;
              const lines = partial.split("\n");
              partial = lines.pop() ?? "";
              for (const line of lines) print(line);
              return;
            }
            if (event.kind === "thinking") {
              const lines = tty ? markdown(event.text, width() - 2, false) : event.text.split("\n");
              for (const line of lines) print(line === "" ? "" : dim(`  ${line}`));
              return;
            }
            if (event.kind === "tool") {
              const detail = event.detail === undefined ? "" : ` ${event.detail}`;
              print(cut(`${speaker(event.session)}[${event.text}]${detail}`, columns() - 1));
              return;
            }
            if (speaker(event.session) !== "") print(dim(speaker(event.session).trim()));
            say(event.text);
            return;
          default:
            return;
        }
      },
    };
  },
});
