import { Tail } from "../follow.ts";
import { holder } from "../lock.ts";
import { eventsPath } from "../paths.ts";
import type { ViewEvent } from "../types.ts";

const WATCH = 500;

export type PlainRenderer = { render(event: ViewEvent): void };

/** The lines penguin prints with no terminal to draw on. */
export function plainRenderer(): PlainRenderer {
  return {
    render(event: ViewEvent): void {
      if (event.type === "agent" && event.kind === "output") {
        process.stdout.write(event.text);
        return;
      }
      const line = lineOf(event);
      if (line !== undefined) process.stdout.write(`${line}\n`);
    },
  };
}

export function resultLine(result: unknown): string | undefined {
  if (result === undefined) return undefined;
  return typeof result === "string" ? result : JSON.stringify(result);
}

/**
 * A run watched without a terminal: the history as lines, then the live tail, and
 * the exit code the run ends with.
 */
export function plainAttach(name: string, dir: string, agent: string): Promise<number> {
  const renderer = plainRenderer();
  let ended: number | undefined;
  let finish = (code: number): void => {
    ended = code;
  };
  const show = (event: ViewEvent): void => {
    if (event.type === "run" && event.phase === "started") {
      renderer.render({ type: "event", level: "info", message: `run ${name} started, ${agent}` });
      return;
    }
    renderer.render(event);
    if (event.type !== "run") return;
    if (event.phase === "done") {
      const line = resultLine(event.result);
      if (line !== undefined) process.stdout.write(`${line}\n`);
      finish(0);
    }
    if (event.phase === "stopped") {
      process.stdout.write(`run ${name} stopped\n`);
      finish(130);
    }
    if (event.phase === "error") {
      process.stdout.write(`run ${name} failed: ${event.reason ?? "unknown error"}\n`);
      finish(1);
    }
  };
  const live = holder(dir) !== undefined;
  const tail = new Tail(eventsPath(dir), (line) => {
    const event = parse(line);
    if (event !== undefined) show(event);
  });
  tail.read();
  if (!live) tail.read();
  if (ended !== undefined) return Promise.resolve(ended);
  if (!live) return Promise.resolve(0);
  return new Promise<number>((resolve) => {
    let settled = false;
    finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      tail.stop();
      resolve(code);
    };
    const watchdog = setInterval(() => {
      if (holder(dir) !== undefined) return;
      tail.read();
      if (settled) return;
      process.stderr.write("pn: the run process died\n");
      finish(1);
    }, WATCH);
    tail.follow();
  });
}

function parse(line: string): ViewEvent | undefined {
  try {
    return JSON.parse(line) as ViewEvent;
  } catch {
    return undefined;
  }
}

function lineOf(event: ViewEvent): string | undefined {
  switch (event.type) {
    case "step":
      return event.phase === "start" ? `step ${event.id} ${event.label}` : undefined;
    case "activity":
      return event.phase === "start" ? event.label : undefined;
    case "wait":
      return event.phase === "start" ? event.label : undefined;
    case "fact":
      return Object.entries(event.values)
        .map(([name, value]) => `${name}: ${value}`)
        .join("  ");
    case "event":
      return event.level === "info" ? event.message : `${event.level}: ${event.message}`;
    case "artifact": {
      const where = event.path ?? event.url;
      return where === undefined ? `artifact: ${event.title}` : `artifact: ${event.title} (${where})`;
    }
    case "agent":
      if (event.kind !== "tool") return event.text;
      return event.detail === undefined ? `[${event.text}]` : `[${event.text}] ${event.detail}`;
    case "gate":
      return event.phase === "asked" ? `gate: ${event.question}` : undefined;
    case "credential":
      if (event.phase === "asked") return askedFor(event);
      if (event.phase === "rejected") {
        return `credential: ${event.label} refused it: ${event.reason}`;
      }
      return `credential ${event.name} ready, from ${event.where}`;
    case "message":
      return `> ${event.text}`;
    default:
      return undefined;
  }
}

function askedFor(event: Extract<ViewEvent, { type: "credential"; phase: "asked" }>): string {
  const lines = [`credential: ${event.label} needs ${event.fields.map((one) => one.name).join(", ")}`];
  if (event.url !== undefined) lines.push(`  make one at ${event.url}`);
  if (event.hint !== undefined) lines.push(`  ${event.hint}`);
  const vars = event.fields.map((field) => field.env).filter((name) => name !== undefined);
  if (vars.length > 0) lines.push(`  or set ${vars.join(", ")} in your environment`);
  return lines.join("\n");
}
