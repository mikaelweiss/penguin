const ANSI = /\x1b\[[0-9;]*m/g;
const ESCAPE = /^\x1b\[[0-9;]*m/;

const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";
const ITALIC = "\x1b[3m";
const UNITALIC = "\x1b[23m";
const UNDER = "\x1b[4m";
const UNUNDER = "\x1b[24m";
const COLOR = "\x1b[36m";
const UNCOLOR = "\x1b[39m";
const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";
const RESET = "\x1b[0m";

const RULE = /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/;
const FENCE = /^\s*(?:```|~~~)/;
const HEADING = /^#{1,6}\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const MARKER = /^\s*(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/;

const NARROWEST = 20;

type Block = { prefix: string; hang: string; parts: string[]; quote?: boolean };

/** The visible width of text that may carry style codes. */
export function wide(text: string): number {
  return text.replace(ANSI, "").length;
}

/** Text at most `columns` wide, style codes not counted, with an ellipsis where it cuts. */
export function cut(text: string, columns: number): string {
  const limit = Math.max(1, columns);
  if (wide(text) <= limit) return text;
  let out = "";
  let taken = 0;
  let index = 0;
  let styled = false;
  while (index < text.length && taken < limit - 1) {
    const escape = ESCAPE.exec(text.slice(index));
    if (escape !== null) {
      out += escape[0];
      index += escape[0].length;
      styled = true;
      continue;
    }
    out += text[index];
    index += 1;
    taken += 1;
  }
  return `${out}…${styled ? RESET : ""}`;
}

/** One line of markdown as the words alone: no syntax, no styling, no runs of space. */
export function plain(line: string): string {
  return inline(line.replace(MARKER, ""), false, false)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Markdown as terminal lines, wrapped to `columns`. Headings read bold, code reads
 * colored, and a list keeps its marker with the rest of the item indented under it.
 * With `styled` off the same layout comes back with the syntax stripped and no codes.
 */
export function markdown(text: string, columns: number, styled = true): string[] {
  const width = Math.max(NARROWEST, columns);
  const out: string[] = [];
  let block: Block | undefined;
  let fenced = false;

  const flush = (): void => {
    if (block === undefined) return;
    const body = inline(block.parts.join(" "), styled, true);
    out.push(...fold(body, width, block.prefix, block.hang));
    block = undefined;
  };
  const gap = (): void => {
    if (out.length > 0 && out.at(-1) !== "") out.push("");
  };

  for (const raw of text.replaceAll("\r\n", "\n").replaceAll("\t", "    ").split("\n")) {
    const line = raw.trimEnd();
    if (FENCE.test(line)) {
      flush();
      gap();
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      out.push(styled ? `${DIM}  ${line}${UNDIM}` : `  ${line}`);
      continue;
    }
    if (line.trim() === "") {
      flush();
      gap();
      continue;
    }
    const heading = HEADING.exec(line.trim());
    if (heading !== null) {
      flush();
      gap();
      const body = inline(heading[1] ?? "", styled, false);
      out.push(...fold(styled ? `${BOLD}${body}${UNBOLD}` : body, width, "", ""));
      continue;
    }
    if (RULE.test(line)) {
      flush();
      gap();
      const bar = "─".repeat(Math.min(width, 40));
      out.push(styled ? `${DIM}${bar}${UNDIM}` : bar);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      flush();
      const pad = nest(bullet[1] ?? "");
      block = { prefix: `${pad}• `, hang: `${pad}  `, parts: [bullet[2] ?? ""] };
      continue;
    }
    const ordered = ORDERED.exec(line);
    if (ordered !== null) {
      flush();
      const pad = nest(ordered[1] ?? "");
      const mark = `${ordered[2]}. `;
      block = { prefix: `${pad}${mark}`, hang: `${pad}${" ".repeat(mark.length)}`, parts: [ordered[3] ?? ""] };
      continue;
    }
    const quote = QUOTE.exec(line);
    if (quote !== null) {
      if (block?.quote !== true) {
        flush();
        block = { prefix: "│ ", hang: "│ ", parts: [], quote: true };
      }
      block.parts.push(quote[1] ?? "");
      continue;
    }
    if (block === undefined) block = { prefix: "", hang: "", parts: [] };
    block.parts.push(line.trim());
  }
  flush();
  while (out.at(-1) === "") out.pop();
  while (out[0] === "") out.shift();
  return out;
}

function nest(indent: string): string {
  return " ".repeat(Math.floor(indent.length / 2) * 2);
}

/** Greedy wrap on the visible width. A style code rides along with its word. */
function fold(text: string, width: number, prefix: string, hang: string): string[] {
  const words = text.split(" ").filter((word) => word !== "");
  if (words.length === 0) return [];
  const out: string[] = [];
  let line = prefix;
  let used = wide(prefix);
  let bare = true;
  for (const word of words) {
    const size = wide(word);
    if (!bare && used + 1 + size > width) {
      out.push(line);
      line = hang + word;
      used = wide(hang) + size;
      continue;
    }
    line += bare ? word : ` ${word}`;
    used += bare ? size : size + 1;
    bare = false;
  }
  out.push(line);
  return out;
}

function inline(text: string, styled: boolean, emphasis: boolean): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const code = /^`([^`\n]+)`/.exec(rest);
    if (code !== null) {
      const body = code[1] ?? "";
      out += styled ? `${COLOR}${body}${UNCOLOR}` : body;
      index += code[0].length;
      continue;
    }
    const link = /^\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link !== null) {
      const label = inline(link[1] ?? "", styled, emphasis);
      const shown = styled ? `${UNDER}${label}${UNUNDER}` : label;
      out += label === "" ? (link[2] ?? "") : `${shown} ${link[2]}`;
      index += link[0].length;
      continue;
    }
    const strong = /^\*\*(.+?)\*\*/.exec(rest);
    if (strong !== null) {
      const body = inline(strong[1] ?? "", styled, emphasis);
      out += styled && emphasis ? `${BOLD}${body}${UNBOLD}` : body;
      index += strong[0].length;
      continue;
    }
    const em = /^\*([^\s*](?:.*?[^\s*])?)\*/.exec(rest);
    if (em !== null) {
      const body = inline(em[1] ?? "", styled, emphasis);
      out += styled && emphasis ? `${ITALIC}${body}${UNITALIC}` : body;
      index += em[0].length;
      continue;
    }
    out += text[index];
    index += 1;
  }
  return out;
}
