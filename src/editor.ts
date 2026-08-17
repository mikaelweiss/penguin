import readline from "node:readline";

export type Key = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  sequence?: string;
};

export type Act = "changed" | "send" | "image" | "none";

export type Attached = { path: string } | { warn: string };

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]");
const PASTE_LINES = 6;
const PASTE_CHARS = 500;

type Span = { start: number; end: number; token: string };

/**
 * The text the user is composing, with the cursor. A large paste collapses to one
 * atomic token on screen, and take() sends the full text.
 */
export class Editor {
  private text = "";
  private cursor = 0;
  private pastes = new Map<string, string>();
  private counter = 0;
  private history: string[] = [];
  private at = 0;
  private stash = "";
  private collecting: string[] | undefined;

  get empty(): boolean {
    return this.text === "" && this.collecting === undefined;
  }

  get busy(): boolean {
    return this.collecting !== undefined;
  }

  get shown(): { text: string; cursor: number } {
    return { text: this.text, cursor: this.cursor };
  }

  key(text: string | undefined, key: Key): Act {
    if (this.collecting !== undefined) {
      if (key.name === "paste-end") {
        const pasted = this.collecting.join("");
        this.collecting = undefined;
        this.paste(pasted);
        return "changed";
      }
      this.collecting.push(key.sequence ?? text ?? "");
      return "none";
    }
    if (key.name === "paste-start") {
      this.collecting = [];
      return "none";
    }
    if (key.ctrl === true) {
      if (key.name === "v") return "image";
      if (key.name === "a") return this.move(0);
      if (key.name === "e") return this.move(this.text.length);
      if (key.name === "u") return this.remove(0, this.cursor);
      if (key.name === "k") return this.remove(this.cursor, this.text.length);
      if (key.name === "w") return this.remove(this.wordStart(), this.cursor);
      if (key.name === "left" || key.name === "b") return this.move(this.wordStart());
      if (key.name === "right" || key.name === "f") return this.move(this.wordEnd());
      return "none";
    }
    if (key.meta === true) {
      if (key.name === "b" || key.name === "left") return this.move(this.wordStart());
      if (key.name === "f" || key.name === "right") return this.move(this.wordEnd());
      if (key.name === "backspace") return this.remove(this.wordStart(), this.cursor);
      return "none";
    }
    if (key.name === "left") return this.move(this.cursor - 1);
    if (key.name === "right") return this.move(this.cursor + 1);
    if (key.name === "home") return this.move(0);
    if (key.name === "end") return this.move(this.text.length);
    if (key.name === "up") return this.recall(-1);
    if (key.name === "down") return this.recall(1);
    if (key.name === "escape") return this.remove(0, this.text.length);
    if (key.name === "backspace") return this.rub();
    if (key.name === "delete") return this.pluck();
    if (key.name === "return" || key.name === "enter" || text === "\r" || text === "\n") {
      return this.text === "" ? "none" : "send";
    }
    if (key.name === "tab") return "none";
    if (text !== undefined && text !== "" && !CONTROL.test(text)) {
      this.insert(text);
      return "changed";
    }
    return "none";
  }

  insert(text: string): void {
    this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
  }

  paste(raw: string): void {
    const text = raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const lines = text.split("\n").length;
    if (lines <= PASTE_LINES && text.length <= PASTE_CHARS) {
      this.insert(text);
      return;
    }
    this.counter += 1;
    const token = `[pasted #${this.counter}, ${lines} lines]`;
    this.pastes.set(token, text);
    this.insert(token);
  }

  /** The full text to send: every token expands. Sending resets the editor. */
  take(): string {
    let out = this.text;
    for (const [token, full] of this.pastes) out = out.replaceAll(token, full);
    if (out !== "") this.history.push(out);
    this.text = "";
    this.cursor = 0;
    this.pastes.clear();
    this.collecting = undefined;
    this.at = this.history.length;
    this.stash = "";
    return out;
  }

  private move(to: number): Act {
    let cursor = Math.max(0, Math.min(this.text.length, to));
    const span = this.spans().find((one) => one.start < cursor && cursor < one.end);
    if (span !== undefined) cursor = to > this.cursor ? span.end : span.start;
    this.cursor = cursor;
    return "changed";
  }

  private rub(): Act {
    if (this.cursor === 0) return "none";
    const span = this.spans().find((one) => one.end === this.cursor);
    if (span !== undefined) return this.remove(span.start, span.end);
    return this.remove(this.cursor - 1, this.cursor);
  }

  private pluck(): Act {
    if (this.cursor >= this.text.length) return "none";
    const span = this.spans().find((one) => one.start === this.cursor);
    if (span !== undefined) return this.remove(span.start, span.end);
    return this.remove(this.cursor, this.cursor + 1);
  }

  /** A removal that touches a token takes the whole token with it. */
  private remove(from: number, to: number): Act {
    if (from >= to) return "none";
    let start = from;
    let end = to;
    for (const span of this.spans()) {
      if (span.start < end && span.end > start) {
        start = Math.min(start, span.start);
        end = Math.max(end, span.end);
        this.pastes.delete(span.token);
      }
    }
    this.text = this.text.slice(0, start) + this.text.slice(end);
    this.cursor = start;
    return "changed";
  }

  private recall(step: number): Act {
    if (this.history.length === 0) return "none";
    const next = this.at + step;
    if (next < 0 || next > this.history.length) return "none";
    if (this.at === this.history.length) this.stash = this.text;
    this.at = next;
    this.text = this.at === this.history.length ? this.stash : (this.history[this.at] ?? "");
    this.cursor = this.text.length;
    return "changed";
  }

  private wordStart(): number {
    let at = this.cursor;
    while (at > 0 && /\s/.test(this.text[at - 1] ?? "")) at -= 1;
    while (at > 0 && !/\s/.test(this.text[at - 1] ?? "")) at -= 1;
    return at;
  }

  private wordEnd(): number {
    let at = this.cursor;
    const stop = this.text.length;
    while (at < stop && /\s/.test(this.text[at] ?? "")) at += 1;
    while (at < stop && !/\s/.test(this.text[at] ?? "")) at += 1;
    return at;
  }

  private spans(): Span[] {
    const found: Span[] = [];
    for (const token of this.pastes.keys()) {
      const start = this.text.indexOf(token);
      if (start !== -1) found.push({ start, end: start + token.length, token });
    }
    return found.sort((left, right) => left.start - right.start);
  }
}

export type Laid = { rows: string[]; row: number; column: number };

/** The screen rows for the buffer, and where the cursor sits among them. */
export function layout(text: string, cursor: number, width: number, prefix: string): Laid {
  const wide = Math.max(4, width);
  const display = prefix + text;
  const at = Math.min(display.length, prefix.length + cursor);
  const rows: string[] = [];
  let row = 0;
  let column = 1;
  let offset = 0;
  for (const line of display.split("\n")) {
    const here = at - offset;
    const mine = here >= 0 && here <= line.length;
    let chunks = Math.max(1, Math.ceil(line.length / wide));
    if (mine && here === line.length && line.length > 0 && line.length % wide === 0) chunks += 1;
    const first = rows.length;
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      rows.push(line.slice(chunk * wide, (chunk + 1) * wide));
    }
    if (mine) {
      row = first + Math.floor(here / wide);
      column = (here % wide) + 1;
    }
    offset += line.length + 1;
  }
  return { rows, row, column };
}

/** The input area on a terminal: the buffer rows and one dim hint row below. */
export class Field {
  private out: NodeJS.WriteStream;
  private editor: Editor;
  private hint: string;
  private title: string[];
  private tall = 0;
  private parked = 0;

  constructor(out: NodeJS.WriteStream, editor: Editor, hint: string, title: string[] = []) {
    this.out = out;
    this.editor = editor;
    this.hint = hint;
    this.title = title;
  }

  get open(): boolean {
    return this.tall > 0;
  }

  draw(): void {
    const width = this.width();
    const { text, cursor } = this.editor.shown;
    const head = this.title.flatMap((line) => layout(line, 0, width, "").rows);
    const laid = layout(text, cursor, width, "> ");
    const rows = [...head, ...laid.rows, `\x1b[2m${this.hint.slice(0, width)}\x1b[22m`];
    this.rise();
    this.out.write(`\r${rows.map((line) => `\x1b[2K${line}`).join("\n")}\n\x1b[J`);
    this.tall = rows.length;
    this.parked = rows.length - head.length - laid.row;
    this.out.write(`\x1b[${this.parked}A\x1b[${laid.column}G`);
  }

  erase(): void {
    if (this.tall === 0) return;
    this.rise();
    this.out.write("\r\x1b[J");
    this.tall = 0;
    this.parked = 0;
  }

  /** Print one line above the field. */
  note(text: string): void {
    const was = this.tall > 0;
    this.erase();
    this.out.write(`${text}\n`);
    if (was) this.draw();
  }

  private rise(): void {
    const up = this.tall - this.parked;
    if (up > 0) this.out.write(`\x1b[${up}A`);
  }

  private width(): number {
    const columns = this.out.columns;
    return columns !== undefined && columns > 0 ? columns : 80;
  }
}

export type AskOptions = {
  notes?: string[];
  attach?: () => Promise<Attached>;
  interrupt: () => void;
};

/**
 * One question, answered in the editor. Enter on an empty buffer resolves to "".
 * On resolve the question erases, per the rule for penguin's own questions.
 */
export function ask(question: string, options: AskOptions): Promise<string> {
  const input = process.stdin;
  const out = process.stdout;
  out.write("\n");
  const editor = new Editor();
  const notes = (options.notes ?? []).map((note) => `  ${note}`);
  const field = new Field(out, editor, "enter confirms, esc clears the line", [question, ...notes]);
  field.draw();
  return new Promise((resolve) => {
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    out.write("\x1b[?2004h");
    let settled = false;
    const leave = (answer: string): void => {
      if (settled) return;
      settled = true;
      out.write("\x1b[?2004l");
      field.erase();
      out.write("\x1b[1A\x1b[J");
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      resolve(answer);
    };
    const onKey = (text: string | undefined, key: Key): void => {
      if (key.ctrl === true && key.name === "c" && !editor.busy) {
        options.interrupt();
        return;
      }
      if ((key.name === "return" || key.name === "enter") && editor.empty) {
        leave("");
        return;
      }
      const act = editor.key(text, key);
      if (act === "send") {
        leave(editor.take());
        return;
      }
      if (act === "image") {
        void (async () => {
          const attach = options.attach;
          if (attach === undefined) return;
          const got = await attach();
          if (settled) return;
          if ("path" in got) {
            editor.insert(got.path);
            field.draw();
          } else {
            field.note(got.warn);
          }
        })();
        return;
      }
      if (act === "changed") field.draw();
    };
    input.on("keypress", onKey);
  });
}
