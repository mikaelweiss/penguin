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

  get empty(): boolean {
    return this.text === "";
  }

  get shown(): { text: string; cursor: number } {
    return { text: this.text, cursor: this.cursor };
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
    this.clear();
    this.at = this.history.length;
    this.stash = "";
    return out;
  }

  clear(): void {
    this.text = "";
    this.cursor = 0;
    this.pastes.clear();
  }

  left(): void {
    this.move(this.cursor - 1);
  }

  right(): void {
    this.move(this.cursor + 1);
  }

  head(): void {
    this.move(0);
  }

  tail(): void {
    this.move(this.text.length);
  }

  wordLeft(): void {
    this.move(this.wordStart());
  }

  wordRight(): void {
    this.move(this.wordEnd());
  }

  killLeft(): void {
    this.remove(0, this.cursor);
  }

  killRight(): void {
    this.remove(this.cursor, this.text.length);
  }

  killWord(): void {
    this.remove(this.wordStart(), this.cursor);
  }

  backspace(): void {
    if (this.cursor === 0) return;
    const span = this.spans().find((one) => one.end === this.cursor);
    if (span !== undefined) return this.remove(span.start, span.end);
    this.remove(this.cursor - 1, this.cursor);
  }

  delete(): void {
    if (this.cursor >= this.text.length) return;
    const span = this.spans().find((one) => one.start === this.cursor);
    if (span !== undefined) return this.remove(span.start, span.end);
    this.remove(this.cursor, this.cursor + 1);
  }

  /** Walk the messages already sent, most recent first. */
  recall(step: number): boolean {
    if (this.history.length === 0) return false;
    const next = this.at + step;
    if (next < 0 || next > this.history.length) return false;
    if (this.at === this.history.length) this.stash = this.text;
    this.at = next;
    this.text = this.at === this.history.length ? this.stash : (this.history[this.at] ?? "");
    this.cursor = this.text.length;
    return true;
  }

  private move(to: number): void {
    let cursor = Math.max(0, Math.min(this.text.length, to));
    const span = this.spans().find((one) => one.start < cursor && cursor < one.end);
    if (span !== undefined) cursor = to > this.cursor ? span.end : span.start;
    this.cursor = cursor;
  }

  /** A removal that touches a token takes the whole token with it. */
  private remove(from: number, to: number): void {
    if (from >= to) return;
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
