export type Block = {
  name: string;
  tokens: string[];
  description: string;
  meta: string;
};

const INDENT = "  ";
const NARROWEST = 40;
const WIDEST = 100;

export function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, index) =>
    Math.max(...rows.map((row) => (row[index] ?? "").length)),
  );
  if (widths === undefined) return "";
  return rows
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function blocks(list: Block[], width = terminalWidth()): string {
  return list.map((block) => lines(block, width).join("\n")).join("\n\n");
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((word) => word !== "")) {
    const joined = line === "" ? word : `${line} ${word}`;
    if (line === "" || joined.length <= width) {
      line = joined;
      continue;
    }
    out.push(line);
    line = word;
  }
  if (line !== "") out.push(line);
  return out;
}

function lines(block: Block, width: number): string[] {
  const out = headline(block.name, block.tokens, width);
  for (const line of wrap(block.description, width - INDENT.length)) {
    out.push(`${INDENT}${line}`);
  }
  if (block.meta !== "") out.push(`${INDENT}${block.meta}`);
  return out;
}

function headline(name: string, tokens: string[], width: number): string[] {
  const out: string[] = [];
  let line = name;
  let gap = INDENT;
  for (const token of tokens) {
    const joined = `${line}${gap}${token}`;
    if (joined.length <= width) {
      line = joined;
      gap = " ";
      continue;
    }
    out.push(line);
    line = `${INDENT}${token}`;
    gap = " ";
  }
  out.push(line);
  return out;
}

function terminalWidth(): number {
  return Math.max(NARROWEST, Math.min(WIDEST, process.stdout.columns ?? 80));
}
