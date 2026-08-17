import fs from "node:fs";
import { eventsPath } from "./paths.ts";
import type { ViewAdapter, ViewEvent } from "./types.ts";

export class Bus {
  private file: string;

  constructor(dir: string) {
    this.file = eventsPath(dir);
  }

  emit(event: ViewEvent): void {
    const at = new Date().toISOString();
    fs.appendFileSync(this.file, `${JSON.stringify({ at, ...event })}\n`);
  }
}

export function plainRenderer(): ViewAdapter {
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

function lineOf(event: ViewEvent): string | undefined {
  switch (event.type) {
    case "step":
      return event.phase === "start" ? `step ${event.id} ${event.label}` : undefined;
    case "activity":
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
      return event.kind === "tool" ? `[${event.text}]` : event.text;
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
