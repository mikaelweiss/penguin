import fs from "node:fs";
import { eventsPath } from "./paths.ts";
import type { ViewAdapter, ViewEvent } from "./types.ts";

type OpenActivity = {
  id: string;
  parent: string | undefined;
  label: string;
  announced: boolean;
};

export class Bus {
  private dir: string;
  private renderer: ViewAdapter;
  private live: boolean;
  private open: OpenActivity[] = [];
  private heldWatch: ViewEvent | undefined;
  private heldFacts: Record<string, string | number | boolean> = {};
  private warned = false;

  constructor(dir: string, renderer: ViewAdapter | undefined, live: boolean) {
    this.dir = dir;
    this.renderer = renderer ?? plainRenderer();
    this.live = live;
  }

  goLive(): void {
    this.live = true;
  }

  isLive(): boolean {
    return this.live;
  }

  openActivity(id: string, parent: string | undefined, label: string): void {
    this.open.push({ id, parent, label, announced: false });
    if (this.live) this.announce();
  }

  closeActivity(id: string, outcome: "ok" | "failed" | "parked"): void {
    const index = this.open.findIndex((entry) => entry.id === id);
    if (index === -1) return;
    const [entry] = this.open.splice(index, 1);
    if (entry?.announced === true) {
      this.deliver({ type: "activity", phase: "end", id, outcome });
    }
  }

  emit(event: ViewEvent, always = false): void {
    if (!this.live && !always) {
      if (event.type === "watch") this.heldWatch = event;
      if (event.type === "fact") Object.assign(this.heldFacts, event.values);
      return;
    }
    this.announce();
    this.deliver(event);
  }

  /** Replay drops emissions. The first live event re-announces the state still standing. */
  private announce(): void {
    for (const entry of this.open) {
      if (entry.announced) continue;
      entry.announced = true;
      this.deliver({
        type: "activity",
        phase: "start",
        id: entry.id,
        parent: entry.parent,
        label: entry.label,
      });
    }
    if (this.heldWatch !== undefined) {
      const held = this.heldWatch;
      this.heldWatch = undefined;
      this.deliver(held);
    }
    if (Object.keys(this.heldFacts).length > 0) {
      const values = this.heldFacts;
      this.heldFacts = {};
      this.deliver({ type: "fact", values });
    }
  }

  private deliver(event: ViewEvent): void {
    fs.appendFileSync(
      eventsPath(this.dir),
      `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    );
    try {
      this.renderer.render(event);
    } catch (error) {
      if (this.warned) return;
      this.warned = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`wa: the view adapter failed: ${message}\n`);
    }
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
    default:
      return undefined;
  }
}
