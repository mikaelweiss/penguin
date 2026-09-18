import path from "node:path";

/** What one screen call may carry beside the patch, in characters. Jev's state window is 32k tokens, and irrelevant state degrades its answers. */
const RELATED_CHARS = 40_000;
const EXCERPT_CHARS = 5_000;
const RELATED_FILES = 12;
/** A patch longer than this is cut, and the report says so on the row. */
const PATCH_CHARS = 30_000;
/** Lines around a mention of an imported name, and the most one declaration excerpt runs. */
const CONTEXT_LINES = 3;
const DECLARATION_LINES = 40;
/** A hunk longer than this splits into windows, so a finding lands on a line and not on a file. */
const HUNK_LINES = 40;
/** How far a barrel's re-export is followed before the declaration is given up. */
const REEXPORT_HOPS = 3;
/** The most test names one screen call carries. */
const TEST_NAMES = 200;

export const SOURCE = /\.(?:[cm]?[jt]sx?|php)$/;
export const TEST =
  /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$|Tests?\.php$/;
const LOCKED = /(?:^|\/)(?:bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock)$/;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const PHP = /\.php$/;

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
export type Excerpt = { path: string; role: "imported" | "importer" | "test" | "twin"; text: string };
export type Tree = { files: string[]; read(file: string): string | undefined };
export type Cells = Record<Dimension, number>;
export type Profile = { path: string; category: string; priority: number };
export type Signal = { path: string; dimension: Dimension; probability: number };
export type Finding = {
  path: string;
  line: number;
  dimension: Dimension;
  probability: number;
  mechanism: string;
  severity: number;
  owner: string | null;
};

export const TIERS = ["ignore", "skim", "deep"] as const;
export type Tier = (typeof TIERS)[number];

/** What the tree says about one changed file, for a reader that would otherwise go find it. */
export type Connection = { path: string; tier: Tier; excerpts: Excerpt[] };

export type Report = {
  files: number;
  tests: number;
  /** How many related files rode along as context, across every screened file. */
  context: number;
  /** The cells the pass followed: the strongest per concern, at or above the floor. */
  floor: number;
  perConcern: number;
  matrix: { path: string; cut: boolean; tier: Tier; cells: Cells }[];
  profiles: Profile[];
  inspected: Signal[];
  connections: Connection[];
  findings: Finding[];
  funnel: { cells: number; inspected: number; located: number; routed: number };
};

/** One claim a review makes, and the code it rests on. */
export type Claim = { claim: string; where: string };

/** What the evidence says about a claim. `unsupported` is the code not showing it, not proof of absence. */
export const VERDICTS = ["supported", "unsupported", "contradicted"] as const;
export type Verdict = (typeof VERDICTS)[number];
export type Checked = Claim & { verdict: Verdict; confidence: number; read: boolean };

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

/**
 * The hunks of one patch, each with the line its first row lands on in the new file. A long
 * hunk splits into windows of the same shape, so a whole new file is not one candidate.
 */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: string[] | undefined;
  let startLine = 1;
  const push = (lines: string[], at: number): void => {
    hunks.push({ id: `hunk_${hunks.length + 1}`, startLine: at, patch: lines.join("\n") });
  };
  const flush = (): void => {
    if (current === undefined) return;
    const body = current.slice(1);
    if (body.length <= HUNK_LINES) {
      push(current, startLine);
      return;
    }
    let line = startLine;
    for (let from = 0; from < body.length; from += HUNK_LINES) {
      const window = body.slice(from, from + HUNK_LINES);
      push([`@@ from line ${line} of the new file @@`, ...window], line);
      line += window.filter((one) => !one.startsWith("-")).length;
    }
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
const PHP_USE = /^use\s+(?:function\s+|const\s+)?([\w\\]+)(?:\s+as\s+\w+)?\s*;/gm;
const PHP_USE_GROUP = /^use\s+([\w\\]+)\\\{([^}]+)\}\s*;/gm;

/** Every module a file names in an import, and the bindings it takes. Empty names means all of them. */
export function importsIn(text: string, file = ""): Import[] {
  if (PHP.test(file)) return phpImportsIn(text);
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

/** A PHP file's `use` lines: the module is the class, the name is what the file calls it. */
function phpImportsIn(text: string): Import[] {
  const found: Import[] = [];
  for (const match of text.matchAll(PHP_USE)) {
    const named = match[1] ?? "";
    found.push({ module: named, names: [named.split("\\").pop() ?? named] });
  }
  for (const match of text.matchAll(PHP_USE_GROUP)) {
    const prefix = match[1] ?? "";
    for (const one of (match[2] ?? "").split(",")) {
      const bare = one.trim().replace(/^(?:function|const)\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "";
      if (bare === "") continue;
      found.push({ module: `${prefix}\\${bare}`, names: [bare.split("\\").pop() ?? bare] });
    }
  }
  return found;
}

/** What the tree says about where a bare module name lands: tsconfig paths and composer PSR-4. */
export type Aliases = {
  /** tsconfig `paths`, exact keys and `prefix/*` keys, each onto its first target. */
  paths: { key: string; target: string }[];
  /** composer `psr-4`, each namespace prefix onto the folder it maps to, relative to the tree root. */
  namespaces: { prefix: string; dir: string }[];
};

/**
 * JSON as tsconfig writes it: comments and trailing commas. Strings are copied through
 * untouched, because a path value such as `libs/*​/src` opens and closes a block comment.
 */
function parseJsonLoosely(text: string): unknown {
  let bare = "";
  let at = 0;
  while (at < text.length) {
    const char = text[at] ?? "";
    if (char === '"') {
      const from = at;
      at += 1;
      while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
      at += 1;
      bare += text.slice(from, at);
      continue;
    }
    if (char === "/" && text[at + 1] === "/") {
      while (at < text.length && text[at] !== "\n") at += 1;
      continue;
    }
    if (char === "/" && text[at + 1] === "*") {
      const ends = text.indexOf("*/", at + 2);
      at = ends === -1 ? text.length : ends + 2;
      continue;
    }
    bare += char;
    at += 1;
  }
  try {
    return JSON.parse(bare.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

/** The alias tables the tree holds: every tsconfig with paths, every composer.json with PSR-4. */
export function aliasesOf(tree: Tree): Aliases {
  const paths: Aliases["paths"] = [];
  const namespaces: Aliases["namespaces"] = [];
  for (const file of tree.files) {
    if (file.includes("node_modules/") || file.includes("vendor/")) continue;
    const base = path.posix.basename(file);
    const dir = path.posix.dirname(file);
    const at = (relative: string): string => path.posix.normalize(dir === "." ? relative : `${dir}/${relative}`);
    if (/^tsconfig(?:\.\w+)?\.json$/.test(base)) {
      const parsed = parseJsonLoosely(tree.read(file) ?? "") as
        | { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }
        | undefined;
      const options = parsed?.compilerOptions;
      if (options?.paths === undefined) continue;
      const root = options.baseUrl === undefined ? "." : options.baseUrl;
      for (const [key, targets] of Object.entries(options.paths)) {
        const target = targets[0];
        if (target === undefined) continue;
        paths.push({ key, target: at(path.posix.join(root, target)) });
      }
    } else if (base === "composer.json") {
      const parsed = parseJsonLoosely(tree.read(file) ?? "") as
        | { autoload?: { "psr-4"?: Record<string, string | string[]> }; "autoload-dev"?: { "psr-4"?: Record<string, string | string[]> } }
        | undefined;
      for (const map of [parsed?.autoload?.["psr-4"], parsed?.["autoload-dev"]?.["psr-4"]]) {
        for (const [prefix, folders] of Object.entries(map ?? {})) {
          const folder = Array.isArray(folders) ? folders[0] : folders;
          if (folder === undefined) continue;
          namespaces.push({ prefix, dir: at(folder).replace(/\/$/, "") });
        }
      }
    }
  }
  namespaces.sort((a, b) => b.prefix.length - a.prefix.length);
  return { paths, namespaces };
}

/** Where an import lands in the tree, or undefined for a package or a path nothing holds. */
export function resolveImport(
  from: string,
  module: string,
  has: (file: string) => boolean,
  aliases: Aliases = { paths: [], namespaces: [] },
): string | undefined {
  if (PHP.test(from)) return resolvePhp(module, has, aliases);
  if (module.startsWith("./") || module.startsWith("../")) {
    return resolveFile(path.posix.normalize(path.posix.join(path.posix.dirname(from), module)), has);
  }
  for (const { key, target } of aliases.paths) {
    if (key.endsWith("/*")) {
      const prefix = key.slice(0, -1);
      if (!module.startsWith(prefix)) continue;
      const landed = resolveFile(path.posix.normalize(target.replace("*", module.slice(prefix.length))), has);
      if (landed !== undefined) return landed;
    } else if (key === module) {
      const landed = resolveFile(target, has);
      if (landed !== undefined) return landed;
    }
  }
  return undefined;
}

function resolveFile(base: string, has: (file: string) => boolean): string | undefined {
  const candidates = [base];
  for (const ext of EXTENSIONS) candidates.push(`${base}${ext}`, `${base}/index${ext}`);
  const swapped = base.replace(/\.([cm]?)js$/, ".$1ts").replace(/\.jsx$/, ".tsx");
  if (swapped !== base) candidates.push(swapped);
  return candidates.find((one) => has(one) && SOURCE.test(one));
}

function resolvePhp(fqcn: string, has: (file: string) => boolean, aliases: Aliases): string | undefined {
  const named = fqcn.replace(/^\\/, "");
  for (const { prefix, dir } of aliases.namespaces) {
    if (!named.startsWith(prefix)) continue;
    const rest = named.slice(prefix.length).split("\\").join("/");
    const file = path.posix.normalize(`${dir}/${rest}.php`);
    if (has(file)) return file;
  }
  return undefined;
}

type Edge = { from: string; to: string; names: string[] };

export type Graph = {
  importsOf(file: string): Edge[];
  importersOf(file: string): Edge[];
  resolve(from: string, module: string): string | undefined;
};

/** Every import edge between the tree's source files, read once for a pass. */
export function graphOf(tree: Tree): Graph {
  const has = new Set(tree.files);
  const aliases = aliasesOf(tree);
  const resolve = (from: string, module: string): string | undefined =>
    resolveImport(from, module, (name) => has.has(name), aliases);
  const outgoing = new Map<string, Edge[]>();
  const incoming = new Map<string, Edge[]>();
  for (const file of tree.files) {
    if (!SOURCE.test(file)) continue;
    const text = tree.read(file);
    if (text === undefined) continue;
    for (const one of importsIn(text, file)) {
      const to = resolve(file, one.module);
      if (to === undefined || to === file) continue;
      const edge = { from: file, to, names: one.names };
      outgoing.set(file, [...(outgoing.get(file) ?? []), edge]);
      incoming.set(to, [...(incoming.get(to) ?? []), edge]);
    }
  }
  return {
    importsOf: (file) => outgoing.get(file) ?? [],
    importersOf: (file) => incoming.get(file) ?? [],
    resolve,
  };
}

const DECLARED =
  /^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+([\w$]+)/;
const TOP_LEVEL = /^(?:export|import|const|let|var|function|class|type|interface|enum|\/\*\*|\/\/)/;
const PHP_DECLARED = /^\s*(?:final\s+|abstract\s+|readonly\s+)*(?:class|interface|trait|enum)\s+(\w+)/;
const PHP_MEMBER = /^\s*(?:public|protected)\s+(?:static\s+)?(?:function\s+\w+\s*\(|const\s+\w+|(?:readonly\s+)?[\w?|\\]+\s+\$\w+)/;

/** The names a file exports through a declaration of its own. */
export function exportedIn(lines: string[], file = ""): string[] {
  if (PHP.test(file)) {
    const named = lines.map((line) => PHP_DECLARED.exec(line)?.[1]).find((one) => one !== undefined);
    return named === undefined ? [] : [named];
  }
  const names: string[] = [];
  for (const line of lines) {
    const named = DECLARED.exec(line)?.[1];
    if (named !== undefined) names.push(named);
    else if (/^export\s+default\b/.test(line)) names.push("default");
  }
  return names;
}

/** The declarations of names in a file, each from its export line to the end of its block. */
export function declarations(text: string, names: string[], file = ""): string {
  if (PHP.test(file)) return phpDeclarations(text);
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

/** A PHP class as its callers see it: the declaration line and every public or protected member's signature. */
function phpDeclarations(text: string): string {
  const lines = text.split("\n");
  const parts: string[] = [];
  let signature: string[] | undefined;
  let at = 0;
  const flush = (): void => {
    if (signature === undefined) return;
    parts.push(`// line ${at}\n${signature.join("\n").trimEnd()}`);
    signature = undefined;
  };
  const ended = (line: string): boolean => /\{|;\s*$/.test(line);
  lines.forEach((line, index) => {
    if (signature !== undefined) {
      signature.push(line);
      if (ended(line)) flush();
      return;
    }
    if (!PHP_DECLARED.test(line) && !PHP_MEMBER.test(line)) return;
    at = index + 1;
    signature = [line];
    if (ended(line)) flush();
  });
  flush();
  return parts.slice(0, DECLARATION_LINES).join("\n\n");
}

const REEXPORT = /\bexport\s+(?:type\s+)?(?:\{([^}]*)\}|\*)\s*from\s*["']([^"']+)["']/g;

/** The names a file re-exports rather than declares, each with the module it came from. */
function reexportsOf(text: string, names: string[]): { module: string; names: string[] }[] {
  const found: { module: string; names: string[] }[] = [];
  for (const match of text.matchAll(REEXPORT)) {
    const [, listed, module] = match;
    if (module === undefined) continue;
    const carried =
      listed === undefined
        ? names
        : names.filter((name) =>
            listed.split(",").some((one) => {
              const bare = one.trim().replace(/^type\s+/, "");
              return bare === name || bare.endsWith(` as ${name}`);
            }),
          );
    if (carried.length > 0) found.push({ module, names: carried });
  }
  return found;
}

/** The declarations of names in a file, following a barrel's re-exports to the file that holds them. */
export function declarationsThrough(
  graph: Graph,
  tree: Tree,
  file: string,
  names: string[],
  hops = REEXPORT_HOPS,
): string {
  const text = tree.read(file);
  if (text === undefined) return "";
  const lines = text.split("\n");
  const own = declarations(text, names, file);
  const held = new Set(exportedIn(lines, file));
  const missing = names.filter((name) => !held.has(name));
  if (hops === 0 || missing.length === 0 || PHP.test(file)) return own;
  const parts = own === "" ? [] : [own];
  for (const one of reexportsOf(text, missing)) {
    const to = graph.resolve(file, one.module);
    if (to === undefined || to === file) continue;
    const said = declarationsThrough(graph, tree, to, one.names, hops - 1);
    if (said !== "") parts.push(`// from ${to}\n${said}`);
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
 * The files a change was copied from: the same path under a sibling folder, with the folder's
 * name tokens swapped in the file name. `a/attachment-uploads/x/list-attachment-uploads.ts`
 * has the twin `a/media-uploads/x/list-media-uploads.ts`. A copy that diverged is a defect
 * the copy alone cannot show.
 */
export function twinsOf(tree: Tree, file: string): string[] {
  const has = new Set(tree.files);
  const parts = file.split("/");
  const twins: string[] = [];
  for (let depth = 0; depth < parts.length - 1; depth++) {
    const folder = parts[depth] ?? "";
    const above = parts.slice(0, depth).join("/");
    const siblings = new Set<string>();
    for (const other of tree.files) {
      if (above !== "" && !other.startsWith(`${above}/`)) continue;
      const name = other.split("/")[depth];
      if (name !== undefined && name !== folder && other.split("/").length > depth + 1) siblings.add(name);
    }
    const mine = folder.split(/[-_.]/);
    for (const sibling of siblings) {
      const theirs = sibling.split(/[-_.]/);
      if (theirs.length !== mine.length) continue;
      const swapped = parts.slice(depth + 1).map((part) =>
        mine.reduce((said, token, index) => {
          const replacement = theirs[index] ?? token;
          return token === replacement ? said : said.replace(new RegExp(`(^|[-_.])${escaped(token)}(?=$|[-_.])`), `$1${replacement}`);
        }, part),
      );
      const candidate = [...parts.slice(0, depth), sibling, ...swapped].join("/");
      if (candidate !== file && has.has(candidate) && SOURCE.test(candidate)) twins.push(candidate);
    }
  }
  return twins;
}

/**
 * What the tree says about one changed file that its patch does not: the declarations it
 * imports, the twins it was copied from, and the places that import it. Contracts first,
 * then twins, then callers by how much they use.
 */
export function relatedTo(graph: Graph, tree: Tree, file: string): Excerpt[] {
  const found: { excerpt: Excerpt; weight: number }[] = [];
  for (const edge of graph.importsOf(file)) {
    const said = declarationsThrough(graph, tree, edge.to, edge.names);
    if (said === "") continue;
    found.push({
      excerpt: { path: edge.to, role: "imported", text: shortened(said) },
      weight: 1_000 + edge.names.length,
    });
  }
  for (const twin of twinsOf(tree, file)) {
    const text = tree.read(twin);
    if (text === undefined) continue;
    const said = declarations(text, [], twin);
    if (said === "") continue;
    found.push({ excerpt: { path: twin, role: "twin", text: shortened(said) }, weight: 500 });
  }
  const exported = exportedIn((tree.read(file) ?? "").split("\n"), file);
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
      path.posix.basename(test.path).replace(/\.(?:spec|test)\.[cm]?[jt]sx?$|Tests?\.php$/, "") === stem,
  );
}

const TEST_NAME = /(?:^|[^\w.])(?:it|test|describe)(?:\.\w+(?:\([^)]*\))?)?\(\s*(['"`])((?:(?!\1).)+)\1/;
const PHP_TEST_NAME = /function\s+(test\w*)\s*\(/;

/** The names of the tests a patch adds or edits, in the order they appear. */
export function testNamesIn(patch: string): string[] {
  const names: string[] = [];
  let attributed = false;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("-") || raw.startsWith("@@")) continue;
    const line = raw.replace(/^[+ ]/, "");
    const named = TEST_NAME.exec(line)?.[2];
    if (named !== undefined) {
      names.push(named);
      continue;
    }
    const method = PHP_TEST_NAME.exec(line)?.[1];
    if (method !== undefined) {
      names.push(method.replace(/^test_?/, "").replace(/_/g, " "));
      attributed = false;
      continue;
    }
    if (/#\[Test\]/.test(line)) {
      attributed = true;
      continue;
    }
    if (attributed) {
      const fn = /function\s+(\w+)\s*\(/.exec(line)?.[1];
      if (fn !== undefined) {
        names.push(fn.replace(/_/g, " "));
        attributed = false;
      }
    }
  }
  return names;
}

export type TestSummary = { path: string; targeted: boolean; tests: string[] };

/**
 * Every changed test as the screen sees it: its path, whether the tree ties it to the file,
 * and the names of the tests it adds. The tied ones come first, and the list stops at a budget.
 */
export function testSummaries(graph: Graph, tests: ChangedFile[], file: string): TestSummary[] {
  const tied = new Set(testsFor(graph, tests, file).map((one) => one.path));
  const ordered = [...tests].sort((a, b) => Number(tied.has(b.path)) - Number(tied.has(a.path)));
  const kept: TestSummary[] = [];
  let spent = 0;
  for (const test of ordered) {
    const names = testNamesIn(test.patch);
    if (names.length === 0) continue;
    const room = TEST_NAMES - spent;
    if (room <= 0) break;
    kept.push({ path: test.path, targeted: tied.has(test.path), tests: names.slice(0, room) });
    spent += Math.min(names.length, room);
  }
  return kept;
}

/** The concerns a pass follows into hunks. A test gap is a fact about the file, and its cell says it. */
export const FOLLOWED = DIMENSIONS.filter((one) => one !== "testGap");
/** On the 0 to 3 priority rubric, where a file is named as one to read closely. */
const CAREFUL = 2;

/**
 * The cells a pass follows: per concern, the strongest files at or above the floor, up to a
 * quota. One loud concern cannot take every slot from the others.
 */
export function signalsOf(
  matrix: { path: string; cells: Cells }[],
  options: { floor: number; perConcern: number },
): Signal[] {
  const picked: Signal[] = [];
  for (const dimension of FOLLOWED) {
    const ranked = matrix
      .map((one) => ({ path: one.path, dimension, probability: one.cells[dimension] }))
      .filter((one) => one.probability >= options.floor)
      .sort((a, b) => b.probability - a.probability)
      .slice(0, options.perConcern);
    picked.push(...ranked);
  }
  return picked.sort((a, b) => b.probability - a.probability);
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

function listed(paths: string[]): string {
  return paths.map((one) => `- \`${one}\``).join("\n");
}

type Grouped = {
  path: string;
  line: number;
  concerns: { dimension: Dimension; mechanism: string }[];
  severity: number;
  owner: string | null;
};

/** One row per place: every concern that landed on the same line, under the most severe one. */
export function grouped(findings: Finding[]): Grouped[] {
  const rows = new Map<string, Grouped>();
  for (const one of [...findings].sort((a, b) => b.severity - a.severity)) {
    const key = `${one.path}:${one.line}`;
    const held = rows.get(key);
    if (held === undefined) {
      rows.set(key, {
        path: one.path,
        line: one.line,
        concerns: [{ dimension: one.dimension, mechanism: one.mechanism }],
        severity: one.severity,
        owner: one.owner,
      });
    } else {
      held.concerns.push({ dimension: one.dimension, mechanism: one.mechanism });
    }
  }
  return [...rows.values()];
}

function concerns(one: Grouped): string {
  return one.concerns
    .map((concern) => `${LABELS[concern.dimension]}: ${titled(concern.mechanism).toLowerCase()}`)
    .join("; ");
}

/** The files a signal pointed at where no window held the evidence up. The reader still looks. */
export function unlocated(report: Report): string[] {
  const located = new Set(report.findings.map((one) => one.path));
  const paths = report.inspected.map((one) => one.path).filter((path) => !located.has(path));
  return [...new Set(paths)];
}

/**
 * The pass as markdown: what to read, what was suspected and where, and what has no test.
 * The screening numbers stay out. A probability is how the pass chose, not something the
 * reader acts on.
 */
export function comment(report: Report, on: string): string {
  const parts = [
    `## Jev pass on ${on}`,
    table(
      ["Files", "Changed tests", "Followed", "Findings"],
      ["r", "r", "r", "r"],
      [[report.files, report.tests, report.funnel.inspected, report.findings.length].map(String)],
    ),
  ];
  parts.push("### Findings");
  if (report.findings.length === 0) {
    parts.push("No signal held up to the evidence in its hunks.");
  } else {
    parts.push(
      table(
        ["Where", "Concern", "Severity", "Owner"],
        ["l", "l", "r", "l"],
        grouped(report.findings).map((one) => [
          `\`${one.path}:${one.line}\``,
          concerns(one),
          `${one.severity.toFixed(1)} / 3`,
          one.owner === null ? "" : titled(one.owner),
        ]),
      ),
    );
  }
  const close = report.profiles.filter((one) => one.priority >= CAREFUL);
  if (close.length > 0) {
    parts.push("### Read closely", listed(close.map((one) => one.path)));
  }
  const open = unlocated(report);
  if (open.length > 0) {
    parts.push(
      "### Suspected, not located",
      `A concern ranked these files highest, and no single hunk carried the evidence:\n\n${listed(open)}`,
    );
  }
  parts.push(
    `<sub>Jev screened ${report.funnel.cells} cells across ${report.files} files with ${report.context} related files as context, and followed the strongest ${report.perConcern} per concern. Findings are review prompts, not proof of a defect. The full review posts separately.</sub>`,
  );
  return parts.join("\n\n");
}

/**
 * The pass as the reader's briefing: the same facts, addressed to the session that will read
 * the tree. It says where to look and what was suspected, never that a defect is there.
 */
export function briefing(report: Report): string {
  const parts = [
    "# Jev screening",
    `A fast model screened every changed file on five concerns and followed the strongest into their hunks. It reads one file at a time and cannot run anything, so this is where to look, not what is wrong. Confirm or dismiss each line from the code.`,
  ];
  if (report.findings.length > 0) {
    parts.push(
      `## Suspected, with a hunk\n\n${grouped(report.findings)
        .map((one) => `- \`${one.path}:${one.line}\` — ${concerns(one)}`)
        .join("\n")}`,
    );
  }
  const open = unlocated(report);
  if (open.length > 0) {
    parts.push(`## Suspected, no hunk carried it\n\n${listed(open)}`);
  }
  const close = report.profiles.filter((one) => one.priority >= CAREFUL);
  if (close.length > 0) {
    parts.push(`## Rated as needing careful review\n\n${listed(close.map((one) => one.path))}`);
  }
  return parts.join("\n\n");
}

/** How much of the tree the reader's prompt carries, in characters. Deep files fill it first. */
const CONNECTION_CHARS = 120_000;

const ROLES: Record<Excerpt["role"], string> = {
  imported: "it calls this",
  importer: "this calls it",
  test: "this tests it",
  twin: "it was copied from this",
};

/**
 * The tree around the change, already read, so the reader does not go find it again. Deep files
 * first, then skim, cut at a budget. Every excerpt carries the line it starts on.
 */
export function connections(report: Report): string {
  const order: Tier[] = ["deep", "skim"];
  const held = report.connections
    .filter((one) => order.includes(one.tier))
    .sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier));
  const parts: string[] = [];
  let spent = 0;
  let dropped = 0;
  for (const one of held) {
    const body = one.excerpts
      .map((excerpt) => `### ${excerpt.path} — ${ROLES[excerpt.role]}\n\n\`\`\`\n${excerpt.text}\n\`\`\``)
      .join("\n\n");
    if (body === "") continue;
    if (spent + body.length > CONNECTION_CHARS) {
      dropped += 1;
      continue;
    }
    parts.push(`## ${one.path} (${one.tier})\n\n${body}`);
    spent += body.length;
  }
  if (parts.length === 0) return "";
  const note =
    dropped === 0
      ? ""
      : `\n\n${dropped} more changed files have connections too large to carry here. Read those from the tree.`;
  return `# Connections\n\nThe import graph already read the tree around each changed file: what it calls, what calls it, what tests it, and the file it was copied from. Line numbers are in the excerpts. Do not grep or re-read these; go to the tree only for what is missing here.${note}\n\n${parts.join("\n\n")}`;
}

/** The tiers as one list, so a reader knows what it may skip without opening it. */
export function tiers(report: Report): string {
  const rows = TIERS.map((tier) => ({
    tier,
    paths: report.matrix.filter((one) => one.tier === tier).map((one) => one.path),
  })).filter((one) => one.paths.length > 0);
  if (rows.length === 0) return "";
  const said = rows.map((one) => `## ${titled(one.tier)}\n\n${listed(one.paths)}`).join("\n\n");
  return `# Tiers\n\nA fast model rated how closely each changed file needs reading. Take these unless the code tells you otherwise, and say so in the dossier when it does.\n\n${said}`;
}

/** A file at or under this many characters goes to the check whole. */
const CLAIM_CHARS = 24_000;
/** Lines around the claim's own line when the file is too big to send whole. */
const CLAIM_SPAN = 160;

/**
 * The code a claim rests on. A claim about ordering or scope is only visible with the block
 * around it, so the whole file goes when it fits, and a wide window around the line when it
 * does not. A narrow window is what makes a true claim look unsupported.
 */
export function codeAt(tree: Tree, where: string, span = CLAIM_SPAN): string | undefined {
  const match = /^(.*?):(\d+)/.exec(where.trim());
  const file = match === null ? where.trim() : (match[1] ?? "");
  const text = tree.read(file);
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  if (text.length <= CLAIM_CHARS) return `// ${file}, whole, from line 1\n${text}`;
  const at = match === null ? 1 : Number(match[2]);
  const from = Math.max(0, at - 1 - Math.floor(span / 2));
  const to = Math.min(lines.length, from + span);
  return `// ${file}, from line ${from + 1} of ${lines.length}\n${lines.slice(from, to).join("\n")}`;
}
