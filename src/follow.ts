import fs from "node:fs";
import path from "node:path";

const POLL = 300;

export class Tail {
  private file: string;
  private onLine: (line: string) => void;
  private offset = 0;
  private watcher: fs.FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(file: string, onLine: (line: string) => void) {
    this.file = file;
    this.onLine = onLine;
  }

  read(): void {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size <= this.offset) return;
    const handle = fs.openSync(this.file, "r");
    const buffer = Buffer.alloc(size - this.offset);
    try {
      fs.readSync(handle, buffer, 0, buffer.length, this.offset);
    } finally {
      fs.closeSync(handle);
    }
    const text = buffer.toString("utf8");
    const cut = text.lastIndexOf("\n");
    if (cut === -1) return;
    this.offset += Buffer.byteLength(text.slice(0, cut + 1));
    for (const line of text.slice(0, cut).split("\n")) {
      if (line.trim() !== "") this.onLine(line);
    }
  }

  follow(): void {
    this.read();
    if (this.stopped) return;
    try {
      this.watcher = fs.watch(path.dirname(this.file), () => this.read());
    } catch {
      this.watcher = undefined;
    }
    this.timer = setInterval(() => this.read(), POLL);
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
