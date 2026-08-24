import fs from "node:fs";
import path from "node:path";
import type { Skill } from "../core/adapter.ts";
import { PenguinError } from "../core/errors.ts";
import * as catalogs from "./catalogs.ts";

export type SkillFound = {
  name: string;
  description: string;
  scope: catalogs.CatalogScope;
  dir: string;
};

export function foundSkills(cwd: string): SkillFound[] {
  return skillsIn(catalogs.roots(cwd));
}

export function skillsIn(list: catalogs.Catalog[]): SkillFound[] {
  const seen = new Set<string>();
  const found: SkillFound[] = [];
  for (const catalog of list) {
    for (const entry of scan(catalogs.skillsDir(catalog), catalog.scope)) {
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      found.push(entry);
    }
  }
  return found;
}

export function locateSkill(name: string, list: catalogs.Catalog[]): SkillFound | undefined {
  return skillsIn(list).find((entry) => entry.name === name);
}

/** Resolves a skill by name against the given catalogs, naming what is installed when it misses. */
export function skillLookup(list: catalogs.Catalog[]): (name: string) => Skill {
  return (name) => {
    const found = locateSkill(name, list);
    if (found === undefined) {
      const names = skillsIn(list)
        .map((entry) => entry.name)
        .join(", ");
      throw new PenguinError(
        names === ""
          ? `no skill named ${name} is installed`
          : `no skill named ${name}. Installed: ${names}`,
      );
    }
    return readSkill(found.dir);
  };
}

export function searchedSkills(cwd: string): string[] {
  return catalogs.roots(cwd).map(catalogs.skillsDir);
}

/** Reads one skill folder's SKILL.md, refusing one that breaks the Agent Skills format. */
export function readSkill(dir: string): Skill {
  const file = path.join(dir, "SKILL.md");
  if (!fs.existsSync(file)) throw new PenguinError(`${dir} has no SKILL.md`);
  const raw = fs.readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (match === null) throw new PenguinError(`${file} has no frontmatter`);
  const fields = new Map<string, string>();
  for (const line of (match[1] ?? "").split("\n")) {
    // An indented line is a nested value, like a metadata entry. Only top-level fields matter here.
    if (/^\s/.test(line)) continue;
    const split = line.indexOf(":");
    if (split === -1) continue;
    fields.set(line.slice(0, split).trim(), line.slice(split + 1).trim());
  }
  const name = fields.get("name") ?? "";
  const description = fields.get("description") ?? "";
  if (name === "" || description === "") {
    throw new PenguinError(`${file} needs name and description frontmatter`);
  }
  const folder = path.basename(dir);
  if (name !== folder) {
    throw new PenguinError(`${file} names ${name} but its folder is ${folder}`);
  }
  return { name, description, dir, text: raw.slice(match[0].length).trim() };
}

function scan(dir: string, scope: catalogs.CatalogScope): SkillFound[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const skill = readSkill(path.join(dir, name));
      return { name: skill.name, description: skill.description, scope, dir: skill.dir };
    });
}
