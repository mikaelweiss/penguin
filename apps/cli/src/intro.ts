const GLYPHS: Record<string, string[]> = {
  p: ["### ", "#  #", "### ", "#   ", "#   "],
  e: ["####", "#   ", "### ", "#   ", "####"],
  n: ["#  #", "## #", "# ##", "#  #", "#  #"],
  g: [" ###", "#   ", "# ##", "#  #", " ###"],
  u: ["#  #", "#  #", "#  #", "#  #", " ## "],
  i: ["###", " # ", " # ", " # ", "###"],
};

const ROWS = 5;
const GAP = 2;
const HEAD = "255;250;235";
const START = [250, 204, 21];
const END = [220, 38, 38];

type Look = { color: boolean; delay: number };

export async function intro(): Promise<void> {
  await wordmark("penguin", { color: color(), delay: 65 });
}

function color(): boolean {
  return process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb";
}

async function wordmark(word: string, look: Look): Promise<void> {
  const pixels = spread(word);
  const width = pixels[0]?.length ?? 0;
  const cell = scale(width);
  const out = process.stdout;
  out.write("\x1b[?25l");
  try {
    for (let edge = 0; edge <= width + 2; edge += 1) {
      out.write(frame(pixels, edge, look, cell));
      await pause(look.delay);
      out.write(`\x1b[${ROWS}A`);
    }
    out.write(frame(pixels, width + 2, look, cell));
    await pause(look.delay * 6);
  } finally {
    out.write("\x1b[?25h");
  }
}

function spread(word: string): string[][] {
  const rows: string[][] = Array.from({ length: ROWS }, () => []);
  for (const letter of word) {
    const glyph = GLYPHS[letter];
    if (glyph === undefined) continue;
    for (let row = 0; row < ROWS; row += 1) {
      if (rows[row]?.length !== 0) rows[row]?.push(...Array<string>(GAP).fill(" "));
      rows[row]?.push(...(glyph[row] ?? "").split(""));
    }
  }
  return rows;
}

function scale(width: number): number {
  const columns = process.stdout.columns ?? 80;
  return width * 2 + 2 <= columns ? 2 : 1;
}

function frame(pixels: string[][], edge: number, look: Look, cell: number): string {
  const width = pixels[0]?.length ?? 0;
  const blank = " ".repeat(cell);
  const block = "█".repeat(cell);
  const lines = pixels.map((row) => {
    let line = "";
    let paint = "";
    for (let column = 0; column < width; column += 1) {
      const lit = row[column] === "#" && column <= edge;
      if (!lit) {
        line += paint === "" ? blank : `\x1b[0m${blank}`;
        paint = "";
        continue;
      }
      const wanted = look.color ? tint(column, width, edge) : "";
      if (wanted !== paint) line += wanted === "" ? "\x1b[0m" : `\x1b[38;2;${wanted}m`;
      paint = wanted;
      line += block;
    }
    return `\x1b[2K  ${line}${paint === "" ? "" : "\x1b[0m"}`;
  });
  return `${lines.join("\n")}\n`;
}

function tint(column: number, width: number, edge: number): string {
  if (edge - column <= 1) return HEAD;
  const share = width < 2 ? 0 : column / (width - 1);
  const channel = (index: number): number =>
    Math.round((START[index] ?? 0) + ((END[index] ?? 0) - (START[index] ?? 0)) * share);
  return `${channel(0)};${channel(1)};${channel(2)}`;
}

function pause(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}
