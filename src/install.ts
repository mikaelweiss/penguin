import fs from "node:fs";
import path from "node:path";
import { installed, writeEnv } from "./adapters.ts";
import { intro } from "./animate.ts";
import { catalog } from "./catalog.gen.ts";
import { home, homeSkills, projectSkills, runsRoot, type Scope, short, userRoot } from "./paths.ts";
import { interactive } from "./tui/tty.ts";
import { link, shared, type Source, sources } from "./skills.ts";

const hint =
  "run `pn list workflows` to see what's available and then `pn run <workflow>` from a project directory to get started";

export async function install(): Promise<void> {
  const fresh = !fs.existsSync(home());
  if (interactive()) await intro();
  fs.mkdirSync(home(), { recursive: true });
  fs.mkdirSync(runsRoot(), { recursive: true });
  if (fresh) {
    copyCatalog();
    writeEnv(process.cwd(), await installed(process.cwd()));
  }
  await syncSkills("global", true);
  say(fresh ? `\ncreated ${short(home())}` : `\npenguin home is ${short(home())}`);
  say(hint);
}

function copyCatalog(): void {
  for (const [name, content] of Object.entries(catalog)) {
    const target = path.join(home(), name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

export async function firstRun(): Promise<boolean> {
  if (fs.existsSync(home())) return false;
  await install();
  return true;
}

export async function syncSkills(scope: Scope, quiet = false): Promise<void> {
  const root = scope === "global" ? userRoot() : process.cwd();
  const target = scope === "global" ? homeSkills() : projectSkills(process.cwd());
  const found = sources(root);
  if (found.length === 0) {
    if (fs.existsSync(target)) link(target, []);
    if (!quiet) say(`\nno .claude/skills or .agents/skills in ${short(root)}`);
    return;
  }
  const chosen = await choose(found);
  link(target, chosen);
  if (!quiet) report(target, chosen);
}

async function choose(found: Source[]): Promise<Source[]> {
  if (!interactive()) return found;
  const { pickOne, pickSome } = await import("./tui/ask.tsx");
  const wanted = await pickSome(
    "Which skill directories should penguin use?",
    found.map((source) => ({ label: short(source.dir) })),
  );
  const chosen = wanted.map((index) => found[index]).filter((source) => source !== undefined);
  if (chosen.length < 2 || shared(chosen).length === 0) return chosen;
  const first = await pickOne(
    "Looks like you have some of the same skills in both directories. Which directory is your preference?",
    chosen.map((source) => ({ label: short(source.dir) })),
  );
  const preferred = chosen[first];
  if (preferred === undefined) return chosen;
  return [preferred, ...chosen.filter((source) => source !== preferred)];
}

function report(target: string, chosen: Source[]): void {
  say(`\nskills in ${short(target)}`);
  if (chosen.length === 0) {
    say("  no directory linked");
    return;
  }
  const overlap = shared(chosen).length > 0;
  for (const [index, source] of chosen.entries()) {
    const win = index === 0 && overlap ? "  (preferred)" : "";
    say(`  ${source.name} -> ${short(source.dir)}${win}`);
  }
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}
