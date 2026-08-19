import { type IBufferCell, type IBufferLine, Terminal } from "@xterm/headless";
import fs from "node:fs";

const SCROLLBACK = 2000;

export type Cursor = { x: number; y: number; visible: boolean };

/** The visible screen of a shell: one line per row, and where its cursor sits in them. */
export type Screen = { lines: (IBufferLine | undefined)[]; cursor: Cursor };

export type { IBufferCell, IBufferLine };

/** One interactive shell in one directory: a pty, the screen it paints, and the keys sent to it. */
export class Shell {
  readonly path: string;
  private readonly term: Terminal;
  private readonly pty: Bun.Terminal;
  private readonly child: Bun.Subprocess;
  private readonly listeners = new Set<() => void>();
  private ended = false;

  constructor(path: string, cols: number, rows: number) {
    this.path = path;
    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.pty = new Bun.Terminal({
      cols,
      rows,
      data: (_pty, bytes) => {
        this.term.write(bytes);
      },
      exit: () => this.end(),
    });
    this.term.onData((data) => {
      if (!this.ended) this.pty.write(data);
    });
    this.term.onWriteParsed(() => this.announce());
    this.child = Bun.spawn([process.env["SHELL"] ?? "/bin/sh"], {
      terminal: this.pty,
      cwd: path,
      env: { ...process.env, TERM: "xterm-256color" },
      onExit: () => this.end(),
    });
    this.pty.unref();
    this.child.unref();
  }

  get alive(): boolean {
    return !this.ended;
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  write(data: string): void {
    if (!this.ended) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.ended || (cols === this.term.cols && rows === this.term.rows)) return;
    this.term.resize(cols, rows);
    this.pty.resize(cols, rows);
  }

  /** Move the window over the scrollback, which is the only way back while the shell holds the keys. */
  scroll(lines: number): void {
    this.term.scrollLines(lines);
    this.announce();
  }

  screen(): Screen {
    const buffer = this.term.buffer.active;
    const lines: (IBufferLine | undefined)[] = [];
    for (let row = 0; row < this.term.rows; row += 1) lines.push(buffer.getLine(buffer.viewportY + row));
    return {
      lines,
      cursor: {
        x: buffer.cursorX,
        y: buffer.cursorY + buffer.baseY - buffer.viewportY,
        visible: !this.ended,
      },
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.end();
    this.child.kill();
    this.pty.close();
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.announce();
  }

  private announce(): void {
    for (const listener of this.listeners) listener();
  }
}

const held = new Map<string, Map<string, Shell>>();

/** The shells penguin holds: one per path per run, alive until the run ends or penguin leaves. */
export const shells = {
  /** The shell on that path, started on the first ask. A directory that is gone opens none. */
  open(run: string, path: string, cols: number, rows: number): Shell | undefined {
    const mine = held.get(run) ?? new Map<string, Shell>();
    held.set(run, mine);
    const found = mine.get(path);
    if (found !== undefined && found.alive) {
      found.resize(cols, rows);
      return found;
    }
    if (found !== undefined) mine.delete(path);
    if (!there(path)) return undefined;
    const made = new Shell(path, cols, rows);
    mine.set(path, made);
    return made;
  },

  closeRun(run: string): void {
    for (const shell of held.get(run)?.values() ?? []) shell.close();
    held.delete(run);
  },

  closeAll(): void {
    for (const mine of held.values()) for (const shell of mine.values()) shell.close();
    held.clear();
  },
};

function there(path: string): boolean {
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}
