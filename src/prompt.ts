import readline from "node:readline";

export type Choice = { label: string; note?: string };

export function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function pick(question: string, choices: Choice[]): Promise<number> {
  const picked = await drive(question, choices, false);
  return picked[0] ?? 0;
}

export function pickMany(question: string, choices: Choice[]): Promise<number[]> {
  return drive(question, choices, true);
}

function rowsOf(line: string): number {
  const columns = process.stdout.columns;
  const width = columns !== undefined && columns > 0 ? columns : 80;
  return Math.max(1, Math.ceil(line.length / width));
}

function drive(question: string, choices: Choice[], many: boolean): Promise<number[]> {
  if (choices.length === 0) return Promise.resolve([]);
  const input = process.stdin;
  const out = process.stdout;
  out.write("\n");
  const chosen = new Set(many ? choices.map((_, index) => index) : []);
  let cursor = 0;
  let tall = 0;

  const marked = (index: number): boolean => (many ? chosen.has(index) : index === cursor);

  const draw = (): void => {
    const keys = many ? "arrows move, space toggles, enter confirms" : "arrows move, enter confirms";
    const lines = [
      question,
      ...choices.map((choice, index) => {
        const here = index === cursor ? ">" : " ";
        const mark = many ? (marked(index) ? "[x]" : "[ ]") : marked(index) ? "(o)" : "( )";
        const note = choice.note === undefined ? "" : `  ${choice.note}`;
        return `${here} ${mark} ${choice.label}${note}`;
      }),
      `  ${keys}`,
    ];
    if (tall > 0) out.write(`\x1b[${tall}A`);
    out.write(`${lines.map((line) => `\x1b[2K${line}`).join("\n")}\n\x1b[J`);
    tall = lines.reduce((total, line) => total + rowsOf(line), 0);
  };

  return new Promise((resolve) => {
    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    const onKey = (text: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl === true && key.name === "c") {
        out.write("\n");
        process.exit(130);
      }
      const named = (...names: string[]): boolean =>
        key.name !== undefined && names.includes(key.name);
      if (named("up", "k")) {
        cursor = (cursor + choices.length - 1) % choices.length;
      } else if (named("down", "j")) {
        cursor = (cursor + 1) % choices.length;
      } else if ((named("space") || text === " ") && many) {
        if (chosen.has(cursor)) chosen.delete(cursor);
        else chosen.add(cursor);
      } else if (named("return", "enter") || text === "\r" || text === "\n") {
        draw();
        input.off("keypress", onKey);
        input.setRawMode(false);
        input.pause();
        resolve(many ? [...chosen].sort((left, right) => left - right) : [cursor]);
        return;
      }
      draw();
    };

    draw();
    input.on("keypress", onKey);
  });
}
