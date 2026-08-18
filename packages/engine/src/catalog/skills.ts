import fs from "node:fs";
import path from "node:path";
import * as catalogs from "./catalogs.ts";

export type SkillSource = { name: string; dir: string };

const ORDER = ".order";

export function skillSources(root: string): SkillSource[] {
  return [
    { name: "claude", dir: path.join(root, ".claude", "skills") },
    { name: "agents", dir: path.join(root, ".agents", "skills") },
  ].filter((source) => fs.existsSync(source.dir));
}

export function linkSkills(target: string, chosen: SkillSource[]): void {
  fs.mkdirSync(target, { recursive: true });
  const owned = new Set(order(target));
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isSymbolicLink() && owned.has(entry.name)) fs.unlinkSync(path.join(target, entry.name));
  }
  for (const source of chosen) {
    const at = path.join(target, source.name);
    if (fs.existsSync(at)) continue;
    fs.symlinkSync(source.dir, at);
  }
  const file = path.join(target, ORDER);
  if (chosen.length === 0) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, `${chosen.map((source) => source.name).join("\n")}\n`);
}

export function sharedSkills(chosen: SkillSource[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const source of chosen) {
    for (const skill of inside(source.dir)) {
      if (seen.has(skill.name)) twice.add(skill.name);
      seen.add(skill.name);
    }
  }
  return [...twice].sort();
}

export type SkillRoot = { dir: string; scope: catalogs.CatalogScope; source: string };

export function skillRoots(dir: string, scope: catalogs.CatalogScope): SkillRoot[] {
  if (!fs.existsSync(dir)) return [];
  const inside = fs
    .readdirSync(dir)
    .filter((name) => name !== ORDER)
    .filter((name) => isCollection(path.join(dir, name)));
  const wanted = order(dir).filter((name) => inside.includes(name));
  const rest = inside.filter((name) => !wanted.includes(name)).sort();
  return [
    { dir, scope, source: "penguin" },
    ...[...wanted, ...rest].map((name) => ({ dir: path.join(dir, name), scope, source: name })),
  ];
}

export function searchPath(cwd: string): SkillRoot[] {
  return searchPathIn(catalogs.roots(cwd));
}

export function searchPathIn(list: catalogs.Catalog[]): SkillRoot[] {
  return list.flatMap((catalog) => skillRoots(catalogs.skillsDir(catalog), catalog.scope));
}

export type Skill = {
  name: string;
  description: string;
  scope: catalogs.CatalogScope;
  source: string;
  at: string;
};

export function availableSkills(cwd: string): Skill[] {
  const taken = new Set<string>();
  const found: Skill[] = [];
  for (const root of searchPath(cwd)) {
    for (const skill of inside(root.dir)) {
      if (taken.has(skill.name)) continue;
      taken.add(skill.name);
      found.push({
        name: skill.name,
        description: descriptionOf(skill.at),
        scope: root.scope,
        source: root.source,
        at: real(skill.at),
      });
    }
  }
  return found;
}

export type Resolved = { file: string } | { file: undefined; searched: string[] };

export function resolve(reference: string, workflow: string, cwd: string): Resolved {
  if (reference.includes("/") || reference.startsWith(".")) {
    const at = path.resolve(path.dirname(workflow), reference);
    const file = skillFile(at);
    return file === undefined ? { file: undefined, searched: [at] } : { file };
  }
  const searched: string[] = [];
  for (const root of searchPath(cwd)) {
    const file = skillFile(path.join(root.dir, reference));
    if (file !== undefined) return { file };
    searched.push(root.dir);
  }
  return { file: undefined, searched };
}

function inside(dir: string): { name: string; at: string }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .sort()
    .map((name) => ({ name: name.replace(/\.md$/, ""), at: path.join(dir, name) }))
    .filter((entry) => skillFile(entry.at) !== undefined);
}

function order(dir: string): string[] {
  const file = path.join(dir, ORDER);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function isCollection(at: string): boolean {
  return directory(at) && !fs.existsSync(path.join(at, "SKILL.md"));
}

function descriptionOf(at: string): string {
  const file = skillFile(at);
  if (file === undefined) return "";
  const text = fs.readFileSync(file, "utf8");
  const front = /^---\n([\s\S]*?)\n---/.exec(text);
  if (front === null) return "";
  for (const line of (front[1] ?? "").split("\n")) {
    const match = /^description:\s*(.*)$/.exec(line);
    if (match !== null) return (match[1] ?? "").trim();
  }
  return "";
}

function skillFile(at: string): string | undefined {
  if (directory(at)) {
    const inside = path.join(at, "SKILL.md");
    return fs.existsSync(inside) ? inside : undefined;
  }
  if (fs.existsSync(at)) return at;
  const markdown = `${at}.md`;
  return fs.existsSync(markdown) ? markdown : undefined;
}

function real(at: string): string {
  try {
    return fs.realpathSync(at);
  } catch {
    return at;
  }
}

function directory(at: string): boolean {
  return fs.existsSync(at) && fs.statSync(at).isDirectory();
}
