#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRun } from "./create.ts";
import { type Outcome, execute } from "./engine.ts";
import { messageOf, WaError } from "./errors.ts";
import { firstRun, install, syncSkills } from "./install.ts";
import { load } from "./loader.ts";
import { parseParams, validate } from "./params.ts";
import { type Scope, short } from "./paths.ts";
import { render as renderRuns, rows } from "./runs.ts";
import * as skills from "./skills.ts";
import * as workflows from "./workflows.ts";

const usage = `wa runs one workflow file as a foreground process.

usage:
  wa list workflows|skills                  show what you can run and what an agent can follow
  wa run <workflow> [--param value ...]     validate params, create the run, execute it
  wa ps                                     show every run
  wa resume <run> [reply]                   replay the journal, then continue
  wa install                                set up ~/.wa and choose your skill directories
  wa sync-skills [--global|--local]         choose your skill directories again

<workflow> is a name from the list, or a path to a workflow file.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "install") {
    await install();
    return 0;
  }
  const fresh = await firstRun();
  if (fresh) {
    if (command === undefined) return 0;
    say("");
  }
  if (command === "run") return runWorkflow(rest);
  if (command === "resume") return resumeRun(rest);
  if (command === "list") return listWhat(rest);
  if (command === "ps") {
    say(renderRuns(rows(Date.now())));
    return 0;
  }
  if (command === "sync-skills") return syncScopes(rest);
  if (command === undefined) return listWorkflows(true);
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return 0;
  }
  throw new WaError(`unknown command ${command}\n\n${usage}`);
}

function listWhat(argv: string[]): number {
  const [what] = argv;
  if (what === "workflows") return listWorkflows();
  if (what === "skills") return listSkills();
  if (what === undefined) {
    throw new WaError("wa list needs a target: wa list workflows or wa list skills");
  }
  if (what === "runs") throw new WaError("wa ps shows the runs");
  throw new WaError(`wa list takes workflows or skills, not ${what}\n\n${usage}`);
}

function listWorkflows(hint = false): number {
  const list = workflows.found(process.cwd());
  if (list.length === 0) {
    say(`no workflow file in ${workflows.searched(process.cwd()).map(short).join(" or ")}`);
    if (hint) process.stdout.write(`\n${usage}`);
    return 0;
  }
  say(workflows.render(list));
  if (hint) say("\nrun one with: wa run <workflow> [--param value ...]");
  return 0;
}

function listSkills(): number {
  const list = skills.available(process.cwd());
  if (list.length === 0) {
    say("no skill yet. wa sync-skills links the ones you have");
    return 0;
  }
  say(skills.render(list));
  return 0;
}

async function syncScopes(argv: string[]): Promise<number> {
  const asked = new Set(argv.map(scopeOf));
  const wanted: Scope[] = asked.size === 0 ? ["global", "local"] : [...asked];
  for (const scope of wanted) await syncSkills(scope);
  return 0;
}

function scopeOf(flag: string): Scope {
  if (flag === "--global") return "global";
  if (flag === "--local") return "local";
  throw new WaError(`unknown option ${flag}\n\n${usage}`);
}

async function runWorkflow(argv: string[]): Promise<number> {
  const [target, ...rest] = argv;
  if (target === undefined) return listWorkflows(true);
  const source = sourceOf(target);
  const definition = await load(source);
  const params = validate(definition.params, parseParams(definition.params, rest));
  const name = createRun(source, params);
  say(`run ${name}`);
  return code(await execute(name));
}

function sourceOf(target: string): string {
  const file = path.resolve(target);
  if (fs.existsSync(file)) return file;
  const named = workflows.locate(target, process.cwd());
  if (named !== undefined) return named;
  const places = workflows.searched(process.cwd()).join(" or ");
  throw new WaError(`no workflow file at ${file}, and no workflow named ${target} in ${places}`);
}

async function resumeRun(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined) throw new WaError(`wa resume needs a run name\n\n${usage}`);
  const reply = rest.length > 0 ? rest.join(" ") : undefined;
  say(`run ${name}`);
  return code(await execute(name, reply));
}

function code(outcome: Outcome): number {
  return outcome === "failed" ? 1 : 0;
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`wa: ${messageOf(error)}\n`);
  if (!(error instanceof WaError) && error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
}
