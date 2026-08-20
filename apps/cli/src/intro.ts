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

type Rgb = readonly [number, number, number];
type Cell = { text: string; rgb?: Rgb };
type Grid = { lit: boolean[][]; width: number; cell: number };

export async function intro(): Promise<void> {
  const out = process.stdout;
  out.write("\x1b[?25l");
  try {
    out.write("\n");
    await snowfall(build("penguin"), color());
    await pause(400);
    out.write("\n");
  } finally {
    out.write("\x1b[?25h");
  }
}

async function snowfall(grid: Grid, paint: boolean): Promise<void> {
  const SKY = 4;
  const starts: number[][] = grid.lit.map((row, rowAt) =>
    row.map(() => (ROWS - 1 - rowAt) * 4 + randInt(8)),
  );
  const startOf = (row: number, col: number): number => starts[row]?.[col] ?? 0;
  const arriveOf = (row: number, col: number): number => startOf(row, col) + SKY + row;
  let last = 0;
  grid.lit.forEach((row, rowAt) =>
    row.forEach((lit, col) => {
      if (lit) last = Math.max(last, arriveOf(rowAt, col));
    }),
  );
  const solid = block(grid);
  await play(last + 6, 55, (frame) => {
    const lines: string[] = [];
    for (let lineAt = 0; lineAt < SKY + ROWS; lineAt += 1) {
      const cells: Array<Cell | null> = [];
      for (let col = 0; col < grid.width; col += 1) {
        const restingRow = lineAt - SKY;
        if (restingRow >= 0 && grid.lit[restingRow]?.[col] === true && frame >= arriveOf(restingRow, col)) {
          cells.push({ text: solid, rgb: mix([235, 246, 255], [110, 180, 255], share(col, grid)) });
          continue;
        }
        let flake: Cell | null = null;
        for (let row = 0; row < ROWS; row += 1) {
          if (grid.lit[row]?.[col] !== true) continue;
          const start = startOf(row, col);
          if (frame >= start && frame < arriveOf(row, col) && frame - start === lineAt) {
            flake = { text: (frame + col) % 2 === 0 ? "*" : "·", rgb: [210, 235, 255] };
            break;
          }
        }
        cells.push(flake);
      }
      lines.push(strip(cells, grid.cell, paint));
    }
    return lines;
  });
}

async function play(count: number, delay: number, render: (frame: number) => string[]): Promise<void> {
  const out = process.stdout;
  for (let frame = 0; frame < count; frame += 1) {
    const lines = render(frame);
    out.write(`${lines.map((line) => `\x1b[2K  ${line}\x1b[0m`).join("\n")}\n`);
    if (frame === count - 1) break;
    await pause(delay);
    out.write(`\x1b[${lines.length}A`);
  }
}

function strip(cells: Array<Cell | null>, wide: number, paint: boolean): string {
  let line = "";
  let current = "";
  for (const cell of cells) {
    if (cell === null) {
      if (current !== "") {
        line += "\x1b[0m";
        current = "";
      }
      line += " ".repeat(wide);
      continue;
    }
    const wanted =
      paint && cell.rgb !== undefined ? `\x1b[38;2;${cell.rgb[0]};${cell.rgb[1]};${cell.rgb[2]}m` : "";
    if (wanted !== current) {
      line += wanted === "" ? "\x1b[0m" : wanted;
      current = wanted;
    }
    line += cell.text.padEnd(wide).slice(0, wide);
  }
  return line;
}

function build(word: string): Grid {
  const rows = spread(word);
  const width = rows[0]?.length ?? 0;
  return { lit: rows.map((row) => row.map((ch) => ch === "#")), width, cell: scale(width) };
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

function block(grid: Grid): string {
  return "█".repeat(grid.cell);
}

function share(col: number, grid: Grid): number {
  return grid.width < 2 ? 0 : col / (grid.width - 1);
}

function mix(a: Rgb, b: Rgb, rawShare: number): Rgb {
  const t = Math.min(1, Math.max(0, rawShare));
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function color(): boolean {
  return process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb";
}

function randInt(bound: number): number {
  return Math.floor(Math.random() * bound);
}

function pause(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}
