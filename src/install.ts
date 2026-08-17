import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installed, writeEnv } from "./adapters.ts";
import { wordmark } from "./animate.ts";
import {
  home,
  homeAdapters,
  homeSkills,
  projectSkills,
  runsRoot,
  type Scope,
  short,
  userRoot,
} from "./paths.ts";
import { interactive, pick, pickMany } from "./prompt.ts";
import { link, shared, type Source, sources } from "./skills.ts";

const hint =
  "run `pn list workflows` to see what's available and then `pn run <workflow>` from a project directory to get started";

export async function install(): Promise<void> {
  const fresh = !fs.existsSync(home());
  if (interactive()) await wordmark("penguin", { color: color(), delay: 65 });
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
  const from = fileURLToPath(new URL("../examples", import.meta.url));
  if (!fs.existsSync(from)) return;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const at = path.join(from, entry.name);
    if (entry.name === "skills") copySkills(at);
    else if (entry.name === "adapters") fs.cpSync(at, homeAdapters(), { recursive: true });
    else if (entry.isFile()) fs.copyFileSync(at, path.join(home(), entry.name));
  }
}

function copySkills(from: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    fs.cpSync(path.join(from, entry.name), path.join(homeSkills(), entry.name), {
      recursive: true,
    });
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
  const wanted = await pickMany(
    "Which skill directories should penguin use?",
    found.map((source) => ({ label: short(source.dir) })),
  );
  const chosen = wanted.map((index) => found[index]).filter((source) => source !== undefined);
  if (chosen.length < 2 || shared(chosen).length === 0) return chosen;
  const first = await pick(
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

function color(): boolean {
  return process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb";
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}
