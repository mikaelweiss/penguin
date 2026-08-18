import { type Skill, type WorkflowFound, short } from "@mikaelweiss/penguin-engine/catalog";
import { type LiveRow } from "@mikaelweiss/penguin-engine/run";

export function workflowBlocks(list: WorkflowFound[], verbose = false): string {
  return blocks(
    list.map((entry) => ({
      name: entry.name,
      tokens: entry.params,
      description: entry.description,
      meta: verbose ? `${entry.scope}  ${short(entry.file)}` : "",
    })),
  );
}

export function skillBlocks(list: Skill[], verbose = false): string {
  return blocks(
    list.map((skill) => ({
      name: skill.name,
      tokens: [],
      description: skill.description,
      meta: verbose ? `${skill.scope}  ${skill.source}  ${short(skill.at)}` : "",
    })),
  );
}

export function adapterBlocks(
  list: { role: string; name: string; description: string; scope: string; file: string }[],
  verbose = false,
): string {
  return blocks(
    list.map((entry) => ({
      name: entry.role,
      tokens: [entry.name],
      description: entry.description,
      meta: verbose ? `${entry.scope}  ${short(entry.file)}` : "",
    })),
  );
}

/** The piped `pn ps` table: live runs, one row each. */
export function liveRunTable(list: LiveRow[]): string {
  const columns: (keyof LiveRow)[] = ["run", "workflow", "state", "detail", "age", "dir"];
  const header = ["RUN", "WORKFLOW", "STATE", "DETAIL", "AGE", "DIRECTORY"];
  return table([header, ...list.map((entry) => columns.map((column) => entry[column]))]);
}

type Block = {
  name: string;
  tokens: string[];
  description: string;
  meta: string;
};

const INDENT = "  ";
const NARROWEST = 40;
const WIDEST = 100;

function table(rows: string[][]): string {
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

function blocks(list: Block[], width = terminalWidth()): string {
  return list.map((block) => lines(block, width).join("\n")).join("\n\n");
}

function wrap(text: string, width: number): string[] {
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
