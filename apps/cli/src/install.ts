import {
  catalogsFile,
  defaultsFile,
  forScope,
  homeCatalog,
  installed,
  linkSkills,
  runsRoot,
  sharedSkills,
  skillSources,
  skillsDir,
  starterCatalog,
  type Scope,
  type SkillSource,
  short,
  userRoot,
  writeEnv,
} from "@mikaelweiss/penguin-engine";
import fs from "node:fs";
import path from "node:path";
import { intro } from "./animate.ts";
import { interactive } from "./tui/tty.ts";

const hint =
  "run `pn list workflows` to see what's available and then `pn run <workflow>` from a project directory to get started";

export async function install(): Promise<void> {
  const dir = homeCatalog().dir;
  const fresh = !fs.existsSync(dir);
  if (interactive()) await intro();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(runsRoot(), { recursive: true });
  if (fresh) {
    enableStarter(dir);
    writeEnv(process.cwd(), await installed(process.cwd()));
  }
  await syncSkills("global", true);
  say(fresh ? `\ncreated ${short(dir)}` : `\npenguin home is ${short(dir)}`);
  say(hint);
}

function enableStarter(dir: string): void {
  fs.writeFileSync(catalogsFile(), "starter\n");
  const shipped = starterCatalog().dir;
  const defaults = fs.readFileSync(path.join(shipped, "defaults"), "utf8");
  fs.writeFileSync(defaultsFile(), defaults.endsWith("\n") ? defaults : `${defaults}\n`);
  fs.copyFileSync(path.join(shipped, "tsconfig.json"), path.join(dir, "tsconfig.json"));
}

export async function firstRun(): Promise<boolean> {
  if (fs.existsSync(homeCatalog().dir)) return false;
  await install();
  return true;
}

export async function syncSkills(scope: Scope, quiet = false): Promise<void> {
  const root = scope === "global" ? userRoot() : process.cwd();
  const target = skillsDir(forScope(process.cwd(), scope));
  const found = skillSources(root);
  if (found.length === 0) {
    if (fs.existsSync(target)) linkSkills(target, []);
    if (!quiet) say(`\nno .claude/skills or .agents/skills in ${short(root)}`);
    return;
  }
  const chosen = await choose(found);
  linkSkills(target, chosen);
  if (!quiet) report(target, chosen);
}

async function choose(found: SkillSource[]): Promise<SkillSource[]> {
  if (!interactive()) return found;
  const { pickOne, pickSome } = await import("./tui/ask.tsx");
  const wanted = await pickSome(
    "Which skill directories should penguin use?",
    found.map((source) => ({ label: short(source.dir) })),
  );
  const chosen = wanted.map((index) => found[index]).filter((source) => source !== undefined);
  if (chosen.length < 2 || sharedSkills(chosen).length === 0) return chosen;
  const first = await pickOne(
    "Looks like you have some of the same skills in both directories. Which directory is your preference?",
    chosen.map((source) => ({ label: short(source.dir) })),
  );
  const preferred = chosen[first];
  if (preferred === undefined) return chosen;
  return [preferred, ...chosen.filter((source) => source !== preferred)];
}

function report(target: string, chosen: SkillSource[]): void {
  say(`\nskills in ${short(target)}`);
  if (chosen.length === 0) {
    say("  no directory linked");
    return;
  }
  const overlap = sharedSkills(chosen).length > 0;
  for (const [index, source] of chosen.entries()) {
    const win = index === 0 && overlap ? "  (preferred)" : "";
    say(`  ${source.name} -> ${short(source.dir)}${win}`);
  }
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}
