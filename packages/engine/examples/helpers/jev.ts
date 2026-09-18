import path from "node:path";

/** What one screen call may carry beside the patch, in characters. Jev's window is about 128k, and irrelevant state degrades its answers. */
const RELATED_CHARS = 40_000;
const EXCERPT_CHARS = 5_000;
const RELATED_FILES = 12;
/** A patch longer than this is cut, and the report says so on the row. */
const PATCH_CHARS = 30_000;
/** Lines around a mention of an imported name, and the most one declaration excerpt runs. */
const CONTEXT_LINES = 3;
const DECLARATION_LINES = 40;
/** The matrix stops here, sorted by the strongest cell, so a wide PR still reads. */
const MATRIX_ROWS = 40;

export const SOURCE = /\.[cm]?[jt]sx?$/;
export const TEST = /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/;
const LOCKED = /(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$/;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export const DIMENSIONS = [
  "correctness",
  "security",
  "reliability",
  "compatibility",
  "testGap",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const LABELS: Record<Dimension, string> = {
  correctness: "Correctness",
  security: "Security",
  reliability: "Reliability",
  compatibility: "Compatibility",
  testGap: "Test gap",
};

export type ChangedFile = { path: string; patch: string; cut: boolean };
export type Hunk = { id: string; startLine: number; patch: string };
export type Excerpt = { path: string; role: "imported" | "importer" | "test"; text: string };
export type Tree = { files: string[]; read(file: string): string | undefined };
export type Cells = Record<Dimension, number>;
export type Profile = { path: string; category: string; priority: number };
export type Finding = {
  path: string;
  line: number;
  dimension: Dimension;
  probability: number;
  mechanism: string;
  severity: number;
  owner: string | null;
  action: "comment" | "request changes";
};
export type Report = {
  files: number;
  tests: number;
  /** How many related files rode along as context, across every screened file. */
  context: number;
  signal: number;
  matrix: { path: string; cut: boolean; cells: Cells }[];
  profiles: Profile[];
  findings: Finding[];
  funnel: { cells: number; signals: number; inspected: number; located: number; routed: number };
};

/** The files a unified diff changes, each with its hunks alone, tests apart from the rest. */
export function changedIn(diff: string): { files: ChangedFile[]; tests: ChangedFile[] } {
  const files: ChangedFile[] = [];
  const tests: ChangedFile[] = [];
  const blocks = diff.split(/^(?=diff --git )/m);
  for (const block of blocks) {
    const lines = block.split("\n");
    if (!lines[0]?.startsWith("diff --git ")) continue;
    if (lines.some((line) => line.startsWith("Binary files") || line === "GIT binary patch")) continue;
    const named = pathOf(lines);
    if (named === undefined || LOCKED.test(named)) continue;
    const first = lines.findIndex((line) => line.startsWith("@@ "));
    if (first === -1) continue;
    const whole = lines.slice(first).join("\n").replace(/\n$/, "");
    const cut = whole.length > PATCH_CHARS;
    const file = { path: named, patch: cut ? whole.slice(0, PATCH_CHARS) : whole, cut };
    (TEST.test(named) ? tests : files).push(file);
  }
  return { files, tests };
}

export type Size = { files: number; lines: number };

/** What a reader faces: the files a unified diff touches and the lines it adds or removes. */
export function sizeOf(diff: string): Size {
  let files = 0;
  let lines = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) files += 1;
    else if (line.startsWith("--- ")) continue;
    else if (line.startsWith("+") || line.startsWith("-")) lines += 1;
  }
  return { files, lines };
}

/** The new path, or the old one when the change deletes the file. */
function pathOf(lines: string[]): string | undefined {
  const added = lines.find((line) => line.startsWith("+++ "));
  const removed = lines.find((line) => line.startsWith("--- "));
  const named = [added, removed]
    .map((line) => line?.slice(4).trim())
    .find((name) => name !== undefined && name !== "/dev/null");
  if (named === undefined) return undefined;
  return named.replace(/^[ab]\//, "");
}

/** The hunks of one patch, each with the line its first row lands on in the new file. */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: string[] | undefined;
  let startLine = 1;
  const flush = (): void => {
    if (current === undefined) return;
    hunks.push({ id: `hunk_${hunks.length + 1}`, startLine, patch: current.join("\n") });
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      flush();
      startLine = Number(/\+(\d+)/.exec(line)?.[1] ?? 1);
      current = [line];
    } else if (current !== undefined) {
      current.push(line);
    }
  }
  flush();
  return hunks;
}

export type Import = { module: string; names: string[] };

const IMPORT =
  /\b(?:import|export)\s+(?:type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+|\*)?\s*from\s*["']([^"']+)["']/g;

/** Every module a file names in an import, and the bindings it takes. Empty names means all of them. */
export function importsIn(text: string): Import[] {
  const found: Import[] = [];
  for (const match of text.matchAll(IMPORT)) {
    const [, fallback, listed, module] = match;
    if (module === undefined) continue;
    const names: string[] = [];
    if (fallback !== undefined) names.push("default");
    if (listed !== undefined) {
      for (const one of listed.split(",")) {
        const bare = one.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "";
        if (bare !== "") names.push(bare);
      }
    }
    const takesAll = fallback === undefined && listed === undefined;
    found.push({ module, names: takesAll ? [] : names });
  }
  return found;
}

/** Where a relative import lands in the tree, or undefined for a package or a path nothing holds. */
export function resolveImport(from: string, module: string, has: (file: string) => boolean): string | undefined {
  if (!module.startsWith("./") && !module.startsWith("../")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), module));
  const candidates = [base];
  for (const ext of EXTENSIONS) candidates.push(`${base}${ext}`, `${base}/index${ext}`);
  const swapped = base.replace(/\.([cm]?)js$/, ".$1ts").replace(/\.jsx$/, ".tsx");
  if (swapped !== base) candidates.push(swapped);
  return candidates.find((one) => has(one) && SOURCE.test(one));
}

type Edge = { from: string; to: string; names: string[] };

export type Graph = {
  importsOf(file: string): Edge[];
  importersOf(file: string): Edge[];
};

/** Every import edge between the tree's source files, read once for a pass. */
export function graphOf(tree: Tree): Graph {
  const has = new Set(tree.files);
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  for (const file of tree.files) {
    if (!SOURCE.test(file)) continue;
    const text = tree.read(file);
    if (text === undefined) continue;
    for (const one of importsIn(text)) {
      const to = resolveImport(file, one.module, (name) => has.has(name));
      if (to === undefined || to === file) continue;
      const edge = { from: file, to, names: one.names };
      outgoing.set(file, [...(outgoing.get(file) ?? []), edge]);
      incoming.set(to, [...(incoming.get(to) ?? []), edge]);
    }
  }
  return {
    importsOf: (file) => outgoing.get(file) ?? [],
    importersOf: (file) => incoming.get(file) ?? [],
  };
}

const DECLARED =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([\w$]+)/;
const TOP_LEVEL = /^(?:export|import|const|let|var|function|class|type|interface|enum|\/\*\*|\/\/)/;

/** The names a file exports through a declaration of its own. */
function exportedIn(lines: string[]): string[] {
  const names: string[] = [];
  for (const line of lines) {
    const named = DECLARED.exec(line)?.[1];
    if (named !== undefined) names.push(named);
    else if (/^export\s+default\b/.test(line)) names.push("default");
  }
  return names;
}

/** The declarations of names in a file, each from its export line to the end of its block. */
export function declarations(text: string, names: string[]): string {
  const lines = text.split("\n");
  const wanted = names.length === 0 ? exportedIn(lines) : names;
  const parts: string[] = [];
  for (const name of wanted) {
    const start = lines.findIndex((line) =>
      name === "default" ? /^export\s+default\b/.test(line) : DECLARED.exec(line)?.[1] === name,
    );
    if (start === -1) continue;
    let end = start + 1;
    while (end < lines.length && end - start < DECLARATION_LINES) {
      const line = lines[end] ?? "";
      if (line.startsWith("}")) {
        end += 1;
        break;
      }
      if (TOP_LEVEL.test(line)) break;
      end += 1;
    }
    parts.push(`// line ${start + 1}\n${lines.slice(start, end).join("\n").trimEnd()}`);
  }
  return parts.join("\n\n");
}

/** The lines of a file that mention any of the names, with a little context, merged in order. */
export function mentions(text: string, names: string[]): string {
  if (names.length === 0) return "";
  const lines = text.split("\n");
  const word = new RegExp(`\\b(?:${names.map(escaped).join("|")})\\b`);
  const windows: [number, number][] = [];
  lines.forEach((line, index) => {
    if (!word.test(line)) return;
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(lines.length, index + CONTEXT_LINES + 1);
    const last = windows[windows.length - 1];
    if (last !== undefined && from <= last[1]) last[1] = to;
    else windows.push([from, to]);
  });
  return windows
    .map(([from, to]) => `// line ${from + 1}\n${lines.slice(from, to).join("\n").trimEnd()}`)
    .join("\n\n");
}

function escaped(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortened(text: string): string {
  if (text.length <= EXCERPT_CHARS) return text;
  return `${text.slice(0, EXCERPT_CHARS)}\n// cut here`;
}

/**
 * What the tree says about one changed file that its patch does not: the declarations it
 * imports, and the places that import it. Contracts first, then callers by how much they use.
 */
export function relatedTo(graph: Graph, tree: Tree, file: string): Excerpt[] {
  const found: { excerpt: Excerpt; weight: number }[] = [];
  for (const edge of graph.importsOf(file)) {
    const text = tree.read(edge.to);
    if (text === undefined) continue;
    const said = declarations(text, edge.names);
    if (said === "") continue;
    found.push({
      excerpt: { path: edge.to, role: "imported", text: shortened(said) },
      weight: 1_000 + edge.names.length,
    });
  }
  const exported = exportedIn((tree.read(file) ?? "").split("\n"));
  for (const edge of graph.importersOf(file)) {
    const text = tree.read(edge.from);
    if (text === undefined) continue;
    const names = edge.names.length === 0 ? exported : edge.names;
    const said = names.length === 0 ? "" : mentions(text, names);
    if (said === "") continue;
    found.push({
      excerpt: { path: edge.from, role: TEST.test(edge.from) ? "test" : "importer", text: shortened(said) },
      weight: said.split("// line ").length,
    });
  }
  found.sort((a, b) => b.weight - a.weight);
  const kept: Excerpt[] = [];
  let spent = 0;
  for (const { excerpt } of found) {
    if (kept.length === RELATED_FILES || spent + excerpt.text.length > RELATED_CHARS) break;
    kept.push(excerpt);
    spent += excerpt.text.length;
  }
  return kept;
}

/** The changed tests that target a file: the ones that import it, and the one named after it. */
export function testsFor(graph: Graph, tests: ChangedFile[], file: string): ChangedFile[] {
  const importers = new Set(graph.importersOf(file).map((edge) => edge.from));
  const stem = path.posix.basename(file).replace(SOURCE, "");
  return tests.filter(
    (test) =>
      importers.has(test.path) ||
      path.posix.basename(test.path).replace(/\.(?:spec|test)\.[cm]?[jt]sx?$/, "") === stem,
  );
}

function cell(value: number, strong: number): string {
  const said = value.toFixed(2);
  return value >= strong ? `**${said}**` : said;
}

function row(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function table(head: string[], align: ("l" | "r")[], rows: string[][]): string {
  const rule = align.map((one) => (one === "r" ? "--:" : "---"));
  return [row(head), row(rule), ...rows.map(row)].join("\n");
}

function titled(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).replace(/([A-Z])/g, " $1").toLowerCase();
}

/** The pass as markdown: the numbers, the profiles, the matrix, the findings. `on` names what was screened. */
export function comment(report: Report, on: string): string {
  const blocking = report.findings.filter((one) => one.action === "request changes").length;
  const parts = [
    `## Jev pass on ${on}`,
    table(
      ["Files", "Changed tests", "Followed", "Findings", "Request changes"],
      ["r", "r", "r", "r", "r"],
      [[report.files, report.tests, report.funnel.inspected, report.findings.length, blocking].map(String)],
    ),
    `**Funnel.** ${report.funnel.cells} cells screened, ${report.funnel.signals} at or above ${report.signal.toFixed(2)}, ${report.funnel.inspected} inspected, ${report.funnel.located} located, ${report.funnel.routed} routed.`,
  ];
  if (report.profiles.length > 0) {
    parts.push(
      "### File profiles",
      table(
        ["File", "Change", "Priority"],
        ["l", "l", "r"],
        report.profiles.map((one) => [`\`${one.path}\``, titled(one.category), `${one.priority.toFixed(1)} / 3`]),
      ),
    );
  }
  const ranked = [...report.matrix]
    .sort((a, b) => Math.max(...Object.values(b.cells)) - Math.max(...Object.values(a.cells)))
    .slice(0, MATRIX_ROWS);
  parts.push(
    "### Matrix",
    table(
      ["File", ...DIMENSIONS.map((one) => LABELS[one])],
      ["l", ...DIMENSIONS.map(() => "r" as const)],
      ranked.map((one) => [
        `\`${one.path}\`${one.cut ? " (patch cut)" : ""}`,
        ...DIMENSIONS.map((dimension) => cell(one.cells[dimension], report.signal)),
      ]),
    ),
  );
  if (report.matrix.length > ranked.length) {
    parts.push(`${report.matrix.length - ranked.length} more files screened below the rows shown.`);
  }
  parts.push("### Findings");
  if (report.findings.length === 0) {
    parts.push("No signal held up to the evidence in its hunks.");
  } else {
    parts.push(
      table(
        ["Where", "Concern", "Mechanism", "Severity", "Owner", "Action"],
        ["l", "l", "l", "r", "l", "l"],
        report.findings.map((one) => [
          `\`${one.path}:${one.line}\``,
          LABELS[one.dimension],
          titled(one.mechanism),
          `${one.severity.toFixed(1)} / 3`,
          one.owner === null ? "" : titled(one.owner),
          one.action,
        ]),
      ),
    );
  }
  parts.push(
    `<sub>Jev screened the diff with ${report.context} related files as context. Findings are review prompts, not proof of a defect. The full review posts separately.</sub>`,
  );
  return parts.join("\n\n");
}
