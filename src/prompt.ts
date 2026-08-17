import readline from "node:readline";

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f]");

export type Choice = { label: string; note?: string };

export type Control = { picked: Promise<number[] | undefined>; cancel(): void };

type Style = {
  many?: boolean;
  cancel?: boolean;
  plain?: boolean;
  keys?: string;
  empty?: boolean;
  interrupt?: () => void;
};

export function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function pick(question: string, choices: Choice[]): Promise<number> {
  const picked = await drive(question, choices, {}).picked;
  return picked?.[0] ?? 0;
}

export async function pickMany(question: string, choices: Choice[]): Promise<number[]> {
  return (await drive(question, choices, { many: true }).picked) ?? [];
}

export async function choose(
  question: string,
  choices: Choice[],
  keys: string,
): Promise<number | undefined> {
  const picked = await drive(question, choices, { cancel: true, plain: true, keys }).picked;
  return picked?.[0];
}

export function control(
  question: string,
  choices: Choice[],
  style: { many: boolean; interrupt: () => void },
): Control {
  return drive(question, choices, { many: style.many, empty: true, interrupt: style.interrupt });
}

export type Field = { name: string; label: string; secret: boolean };

export type Entry = { taken: Promise<Record<string, string> | undefined>; cancel(): void };

/** One field at a time. A secret field echoes stars, so it never reaches the screen. */
export function entry(
  title: string,
  notes: string[],
  fields: Field[],
  style: { interrupt: () => void },
): Entry {
  const first = fields[0];
  if (first === undefined) return { taken: Promise.resolve({}), cancel: () => {} };
  const input = process.stdin;
  const out = process.stdout;
  out.write("\n");
  const values: Record<string, string> = {};
  let field = first;
  let at = 0;
  let buffer = "";
  let tall = 0;

  const masked = (one: Field, text: string): string => (one.secret ? "*".repeat(text.length) : text);

  const draw = (): void => {
    const lines = [
      title,
      ...notes.map((note) => `  ${note}`),
      ...fields
        .slice(0, at)
        .map((one) => `  ${one.label}: ${masked(one, values[one.name] ?? "")}`),
      `  ${field.label}`,
      `> ${masked(field, buffer)}`,
      "  enter confirms, esc clears the line",
    ];
    if (tall > 0) out.write(`\x1b[${tall}A`);
    out.write(`${lines.map((line) => `\x1b[2K${line}`).join("\n")}\n\x1b[J`);
    tall = lines.reduce((total, line) => total + rowsOf(line), 0);
  };

  let cancel = (): void => {};
  const taken = new Promise<Record<string, string> | undefined>((resolve) => {
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    let settled = false;
    const leave = (result: Record<string, string> | undefined): void => {
      if (settled) return;
      settled = true;
      out.write(`\x1b[${tall + 1}A\x1b[J`);
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      resolve(result);
    };

    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl === true && key.name === "c") {
        style.interrupt();
        return;
      }
      if (key.name === "escape") {
        buffer = "";
      } else if (key.name === "backspace") {
        buffer = buffer.slice(0, -1);
      } else if (key.name === "return" || key.name === "enter" || text === "\r" || text === "\n") {
        if (buffer.trim() === "") return;
        values[field.name] = buffer.trim();
        buffer = "";
        at += 1;
        const next = fields[at];
        if (next === undefined) {
          leave(values);
          return;
        }
        field = next;
      } else if (text !== undefined && text !== "" && !CONTROL.test(text)) {
        buffer += text;
      }
      draw();
    };

    cancel = (): void => leave(undefined);
    draw();
    input.on("keypress", onKey);
  });
  return { taken, cancel: () => cancel() };
}

function rowsOf(line: string): number {
  const columns = process.stdout.columns;
  const width = columns !== undefined && columns > 0 ? columns : 80;
  return Math.max(1, Math.ceil(line.length / width));
}

function drive(question: string, choices: Choice[], style: Style): Control {
  if (choices.length === 0) return { picked: Promise.resolve([]), cancel: () => {} };
  const many = style.many === true;
  const input = process.stdin;
  const out = process.stdout;
  out.write("\n");
  const chosen = new Set(many && style.empty !== true ? choices.map((_, index) => index) : []);
  let cursor = 0;
  let tall = 0;

  const marked = (index: number): boolean => (many ? chosen.has(index) : index === cursor);

  const draw = (): void => {
    const keys =
      style.keys ?? (many ? "arrows move, space toggles, enter confirms" : "arrows move, enter confirms");
    const lines = [
      question,
      ...choices.map((choice, index) => {
        const here = index === cursor ? ">" : " ";
        const box = many ? (marked(index) ? "[x]" : "[ ]") : marked(index) ? "(o)" : "( )";
        const mark = style.plain === true ? "" : `${box} `;
        const note = choice.note === undefined ? "" : `  ${choice.note}`;
        return `${here} ${mark}${choice.label}${note}`;
      }),
      `  ${keys}`,
    ];
    if (tall > 0) out.write(`\x1b[${tall}A`);
    out.write(`${lines.map((line) => `\x1b[2K${line}`).join("\n")}\n\x1b[J`);
    tall = lines.reduce((total, line) => total + rowsOf(line), 0);
  };

  let cancel = (): void => {};
  const picked = new Promise<number[] | undefined>((resolve) => {
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    let settled = false;
    const leave = (taken: number[] | undefined): void => {
      if (settled) return;
      settled = true;
      out.write(`\x1b[${tall + 1}A\x1b[J`);
      input.off("keypress", onKey);
      input.setRawMode(false);
      input.pause();
      resolve(taken);
    };

    const onKey = (text: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl === true && key.name === "c") {
        if (style.interrupt !== undefined) {
          style.interrupt();
          return;
        }
        out.write("\n");
        process.exit(130);
      }
      const named = (...names: string[]): boolean =>
        key.name !== undefined && names.includes(key.name);
      if (named("up", "k", "h")) {
        cursor = (cursor + choices.length - 1) % choices.length;
      } else if (named("down", "j", "l")) {
        cursor = (cursor + 1) % choices.length;
      } else if ((named("space") || text === " ") && many) {
        if (chosen.has(cursor)) chosen.delete(cursor);
        else chosen.add(cursor);
      } else if (style.cancel === true && named("q", "escape")) {
        leave([]);
        return;
      } else if (named("return", "enter") || text === "\r" || text === "\n") {
        leave(many ? [...chosen].sort((left, right) => left - right) : [cursor]);
        return;
      }
      draw();
    };

    cancel = (): void => leave(undefined);
    draw();
    input.on("keypress", onKey);
  });
  return { picked, cancel: () => cancel() };
}
