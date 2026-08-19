const ANSI = /\x1b\[[0-9;]*m/g;
const ESCAPE = /^\x1b\[[0-9;]*m/;
const RESET = "\x1b[0m";
const MARKER = /^\s*(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/;

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

/** Text at most `columns` wide, keeping its end, which is the half that names a directory. */
export function tail(text: string, columns: number): string {
  const limit = Math.max(1, columns);
  if (wide(text) <= limit) return text;
  return `…${text.slice(text.length - limit + 1)}`;
}

/** The parts that fit one row, two spaces apart. The first part that does not fit ends the row. */
export function fit(parts: string[], columns: number): string {
  let row = "";
  for (const part of parts) {
    const next = row === "" ? part : `${row}  ${part}`;
    if (wide(next) > columns) break;
    row = next;
  }
  return row === "" ? cut(parts[0] ?? "", columns) : row;
}

/** One line of markdown as the words alone: no syntax, no styling, no runs of space. */
export function plain(line: string): string {
  return line
    .replace(MARKER, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, label: string, href: string) =>
      label === "" ? href : `${label} ${href}`,
    )
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*([^\s*](?:.*?[^\s*])?)\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
