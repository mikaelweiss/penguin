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
  const paint = color();
  const grid = build("penguin");
  const shows: Array<{ name: string; run: () => Promise<void> }> = [
    { name: "1/7 snowfall", run: () => snowfall(grid, paint) },
    { name: "2/7 waddle", run: () => waddle(grid, paint) },
    { name: "3/7 decode", run: () => decode(grid, paint) },
    { name: "4/7 belly slide", run: () => bellySlide(grid, paint) },
    { name: "5/7 mascot", run: () => mascot(paint) },
    { name: "6/7 dot matrix", run: () => dotMatrix(paint) },
    { name: "7/7 tide", run: () => tide(paint) },
  ];
  const out = process.stdout;
  out.write("\x1b[?25l");
  try {
    for (const show of shows) {
      out.write(paint ? `\n  \x1b[2m${show.name}\x1b[0m\n\n` : `\n  ${show.name}\n\n`);
      await show.run();
      await pause(800);
    }
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

async function waddle(grid: Grid, paint: boolean): Promise<void> {
  const wide = grid.width * grid.cell;
  const WALK: string[][] = [
    ["(o_", "//\\", "V_/"],
    ["(o_", "//\\", "\\_V"],
  ];
  const solid = block(grid);
  await play(wide + 12, 30, (frame) => {
    const x = frame - 4;
    const lines: string[] = [];
    for (let row = 0; row < ROWS; row += 1) {
      const cells: Array<Cell | null> = [];
      for (let col = 0; col < grid.width; col += 1) {
        if (grid.lit[row]?.[col] !== true || col * grid.cell >= x) {
          cells.push(null);
          continue;
        }
        const edge = x - col * grid.cell <= 3;
        cells.push({ text: solid, rgb: edge ? [255, 176, 46] : [242, 242, 242] });
      }
      lines.push(strip(cells, grid.cell, paint));
    }
    const body = [empty(wide), empty(wide), empty(wide)];
    const ground = body[2];
    if (ground !== undefined) {
      for (let mark = 2; mark < Math.min(x - 2, wide); mark += 4) {
        ground[mark] = { text: mark % 8 === 2 ? "." : ",", rgb: [130, 148, 165] };
      }
    }
    const pose = WALK[Math.floor(frame / 3) % 2] ?? [];
    pose.forEach((part, at) => {
      const line = body[at];
      if (line !== undefined) stamp(line, x, part, [248, 248, 248]);
    });
    lines.push(...body.map((cells) => strip(cells, 1, paint)));
    return lines;
  });
}

async function decode(grid: Grid, paint: boolean): Promise<void> {
  const NOISE = ["░", "▒", "▓", "#", "%", "+", "*"];
  const locks: number[][] = grid.lit.map((row) =>
    row.map((_, col) => 6 + share(col, grid) * 18 + randInt(8)),
  );
  const solid = block(grid);
  const noise = (rgb: Rgb): Cell => ({
    text: (NOISE[randInt(NOISE.length)] ?? "░").repeat(grid.cell),
    rgb,
  });
  await play(36, 45, (frame) => {
    const lines: string[] = [];
    for (let row = 0; row < ROWS; row += 1) {
      const cells: Array<Cell | null> = [];
      for (let col = 0; col < grid.width; col += 1) {
        const lit = grid.lit[row]?.[col] === true;
        if (lit && frame >= (locks[row]?.[col] ?? 0)) {
          cells.push({ text: solid, rgb: mix([94, 255, 130], [0, 208, 255], share(col, grid)) });
        } else if (lit) {
          cells.push(noise([36, 148, 84]));
        } else if (frame < 10 && chance(0.05 * (1 - frame / 10))) {
          cells.push(noise([70, 82, 74]));
        } else cells.push(null);
      }
      lines.push(strip(cells, grid.cell, paint));
    }
    return lines;
  });
}

async function bellySlide(grid: Grid, paint: boolean): Promise<void> {
  const wide = grid.width * grid.cell;
  const SHIFT = [-6, -4, -2, -1, 0, 1, 0];
  const SPEED = 2;
  const SPRITE = "~~(o>";
  const glide = Math.ceil((wide + 14) / SPEED);
  const solid = block(grid);
  await play(glide + SHIFT.length + 4, 35, (frame) => {
    const x = frame * SPEED - 8;
    const nose = x + SPRITE.length;
    const shiftAt = (col: number): number | null => {
      const passed = nose - col * grid.cell;
      if (passed < 0) return null;
      return SHIFT[Math.min(Math.floor(passed / SPEED), SHIFT.length - 1)] ?? 0;
    };
    const tint = (col: number, falling: boolean): Rgb => {
      const base = mix([255, 202, 64], [255, 96, 96], share(col, grid));
      return falling ? mix(base, [255, 255, 255], 0.55) : base;
    };
    const lines: string[] = [];
    for (let lineAt = 0; lineAt < ROWS; lineAt += 1) {
      const cells: Array<Cell | null> = [];
      for (let col = 0; col < grid.width; col += 1) {
        const shift = shiftAt(col);
        if (shift === null) {
          cells.push(null);
          continue;
        }
        const row = lineAt - shift;
        if (row >= 0 && row < ROWS && grid.lit[row]?.[col] === true) {
          cells.push({ text: solid, rgb: tint(col, shift !== 0) });
        } else cells.push(null);
      }
      lines.push(strip(cells, grid.cell, paint));
    }
    const lane = empty(wide);
    for (let col = 0; col < grid.width; col += 1) {
      if (shiftAt(col) === 1 && grid.lit[ROWS - 1]?.[col] === true) {
        for (let at = 0; at < grid.cell; at += 1) {
          lane[col * grid.cell + at] = { text: "█", rgb: tint(col, true) };
        }
      }
    }
    if (x > -SPRITE.length && x < wide + SPRITE.length) {
      for (let puff = 0; puff < 3; puff += 1) {
        const at = x - 1 - randInt(6);
        if (at >= 0 && at < wide) lane[at] = { text: "*", rgb: [188, 232, 255] };
      }
    }
    stamp(lane, x, SPRITE, [250, 250, 250]);
    stamp(lane, x + SPRITE.length - 1, ">", [255, 176, 46]);
    lines.push(strip(lane, 1, paint));
    const ice: Array<Cell | null> = Array.from({ length: wide }, () => ({
      text: "▔",
      rgb: [150, 200, 240] as Rgb,
    }));
    lines.push(strip(ice, 1, paint));
    return lines;
  });
}

async function mascot(paint: boolean): Promise<void> {
  const OPEN = "     |o_o |";
  const SHUT = "     |-_- |";
  const ART = [
    "      .--.",
    OPEN,
    "     |\\_/ |",
    "    //   \\ \\",
    "   (|     | )",
    "  /'\\_   _/`\\",
    "  \\___)=(___/",
  ];
  const WORD = "penguin";
  const TYPE_AT = 10;
  const PACE = 3;
  await play(52, 55, (frame) => {
    const shown = Math.min(ART.length, frame + 1);
    const typed = Math.max(0, Math.min(WORD.length, Math.floor((frame - TYPE_AT) / PACE)));
    const doneAt = TYPE_AT + WORD.length * PACE;
    const cursorOn = frame < doneAt || Math.floor(frame / 4) % 2 === 0;
    const blink = (frame >= 36 && frame <= 38) || (frame >= 46 && frame <= 48);
    const lines: string[] = [];
    for (let at = 0; at < ART.length; at += 1) {
      const row = empty(40);
      if (at < shown) stamp(row, 0, at === 1 && blink ? SHUT : (ART[at] ?? ""), [238, 240, 244]);
      if (at === 3) {
        stamp(row, 20, WORD.slice(0, typed), [255, 255, 255]);
        if (frame >= TYPE_AT && cursorOn) stamp(row, 20 + typed, "▌", [255, 176, 46]);
      }
      lines.push(strip(row, 1, paint));
    }
    return lines;
  });
}

async function dotMatrix(paint: boolean): Promise<void> {
  const DOTS: Record<string, string[]> = {
    P: ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
    E: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
    N: ["#...#", "##..#", "##..#", "#.#.#", "#..##", "#..##", "#...#"],
    G: [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".###."],
    U: ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
    I: ["###", ".#.", ".#.", ".#.", ".#.", ".#.", "###"],
  };
  const art: string[] = Array.from({ length: 7 }, () => "");
  for (const letter of "PENGUIN") {
    const glyph = DOTS[letter];
    if (glyph === undefined) continue;
    for (let row = 0; row < 7; row += 1) {
      const before = art[row] ?? "";
      art[row] = `${before}${before === "" ? "" : "."}${glyph[row] ?? ""}`;
    }
  }
  const wide = art[0]?.length ?? 0;
  const PACE = 7;
  const steps = Math.ceil(wide / PACE);
  await play(7 * steps + 8, 40, (frame) => {
    const band = Math.floor(frame / steps);
    const headX = ((frame % steps) + 1) * PACE;
    const lines: string[] = [];
    for (let row = 0; row < 7; row += 1) {
      const cells = empty(wide + 4);
      if (row % 2 === 0) {
        cells[0] = { text: "o", rgb: [110, 122, 134] };
        cells[wide + 3] = { text: "o", rgb: [110, 122, 134] };
      }
      for (let col = 0; col < wide; col += 1) {
        if (art[row]?.[col] !== "#") continue;
        const printed = row < band || (row === band && col < headX);
        if (!printed) continue;
        const fresh = row === band && col >= headX - PACE;
        cells[col + 2] = { text: "●", rgb: fresh ? [255, 214, 110] : [226, 229, 233] };
      }
      if (row === band && band < 7) {
        cells[Math.min(wide - 1, headX) + 2] = { text: "█", rgb: [255, 150, 50] };
      }
      lines.push(strip(cells, 1, paint));
    }
    return lines;
  });
}

async function tide(paint: boolean): Promise<void> {
  const SLANT: string[][] = [
    ["   ___ ", "  / _ \\", " / .__/", "/_/    "],
    ["  ___ ", " / -_)", " \\__/ ", "      "],
    ["  ___  ", " / _ \\ ", "/_//_/ ", "       "],
    ["  ___  ", " / _ `/", " \\_, / ", "/___/  "],
    [" __ __ ", "/ // / ", "\\_,_/  ", "       "],
    ["  (_)", " / / ", "/_/  ", "     "],
    ["  ___  ", " / _ \\ ", "/_//_/ ", "       "],
  ];
  const art = [0, 1, 2, 3].map((row) => SLANT.map((glyph) => glyph[row] ?? "").join(""));
  const width = art[0]?.length ?? 0;
  await play(44, 55, (frame) => {
    const rise = Math.max(0, 4 - Math.floor(frame / 4));
    const lines: string[] = [];
    for (let line = 0; line < 4; line += 1) {
      const row = empty(width);
      const source = art[line - rise];
      if (line - rise >= 0 && source !== undefined) stamp(row, 0, source, [235, 240, 248]);
      lines.push(strip(row, 1, paint));
    }
    const water = empty(width);
    for (let col = 0; col < width; col += 1) {
      if ((col + frame) % 8 < 6) water[col] = { text: "~", rgb: [86, 156, 214] };
    }
    lines.push(strip(water, 1, paint));
    for (let depth = 1; depth <= 3; depth += 1) {
      const row = empty(width);
      const index = 4 - depth - rise;
      const source = index >= 0 && index < 4 ? art[index] : undefined;
      if (source !== undefined) {
        const jitter = randInt(3) - 1;
        for (let at = 0; at < source.length; at += 1) {
          const ch = source[at] ?? " ";
          if (ch === " " || chance(0.3)) continue;
          const col = at + jitter;
          if (col < 0 || col >= width) continue;
          const mirrored = ch === "/" ? "\\" : ch === "\\" ? "/" : ch;
          row[col] = { text: mirrored, rgb: [64, 104, 150] };
        }
      }
      lines.push(strip(row, 1, paint));
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

function stamp(row: Array<Cell | null>, x: number, text: string, rgb: Rgb): void {
  for (let at = 0; at < text.length; at += 1) {
    const ch = text[at] ?? " ";
    const col = x + at;
    if (ch === " " || col < 0 || col >= row.length) continue;
    row[col] = { text: ch, rgb };
  }
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

function empty(wide: number): Array<Cell | null> {
  return Array.from({ length: wide }, () => null);
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

function chance(probability: number): boolean {
  return Math.random() < probability;
}

function randInt(bound: number): number {
  return Math.floor(Math.random() * bound);
}

function pause(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}
