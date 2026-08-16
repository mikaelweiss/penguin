import fs from "node:fs";
import { wordmark } from "./animate.ts";
import { home, homeSkills, projectSkills, runsRoot, type Scope, short, userRoot } from "./paths.ts";
import { interactive, pick, pickMany } from "./prompt.ts";
import { link, shared, type Source, sources } from "./skills.ts";

export async function install(): Promise<void> {
  const fresh = !fs.existsSync(home());
  if (interactive()) await wordmark("wa", { color: color(), delay: 65 });
  fs.mkdirSync(runsRoot(), { recursive: true });
  say(fresh ? `\ncreated ${short(home())}` : `\nwa home is ${short(home())}`);
  await syncSkills("global");
  say(`\nput a workflow file in ${short(home())}, then run wa list`);
}

export async function firstRun(): Promise<void> {
  if (fs.existsSync(home())) return;
  await install();
  say("");
}

export async function syncSkills(scope: Scope): Promise<void> {
  const root = scope === "global" ? userRoot() : process.cwd();
  const target = scope === "global" ? homeSkills() : projectSkills(process.cwd());
  const found = sources(root);
  if (found.length === 0) {
    if (fs.existsSync(target)) link(target, []);
    say(`\nno .claude/skills or .agents/skills in ${short(root)}`);
    return;
  }
  const chosen = await choose(found);
  link(target, chosen);
  report(target, chosen);
}

async function choose(found: Source[]): Promise<Source[]> {
  if (!interactive()) return found;
  const wanted = await pickMany(
    "Which skill directories should wa use?",
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
  const both = shared(chosen);
  for (const [index, source] of chosen.entries()) {
    const win = index === 0 && both.length > 0 ? "  (preferred)" : "";
    say(`  ${source.name} -> ${short(source.dir)}${win}`);
  }
  if (both.length === 1) say(`  1 skill is in both: ${both[0]}`);
  if (both.length > 1) say(`  ${both.length} skills are in both: ${listed(both)}`);
  say("  a skill you add later shows up on its own");
}

function listed(names: string[]): string {
  if (names.length <= 6) return names.join(", ");
  return `${names.slice(0, 6).join(", ")}, and ${names.length - 6} more`;
}

function color(): boolean {
  return process.env["NO_COLOR"] === undefined && process.env["TERM"] !== "dumb";
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}
