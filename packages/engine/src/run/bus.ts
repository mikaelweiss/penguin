import fs from "node:fs";
import { eventsPath } from "../paths.ts";
import type { ViewEvent } from "../core/message.ts";

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
