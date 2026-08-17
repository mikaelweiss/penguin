#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as adapters from "./adapters.ts";
import { createRun } from "./create.ts";
import { execute } from "./engine.ts";
import { messageOf, WaError } from "./errors.ts";
import { firstRun, install, syncSkills } from "./install.ts";
import { blocks } from "./layout.ts";
import { load } from "./loader.ts";
import { parseParams, validate } from "./params.ts";
import { type Scope, short } from "./paths.ts";
import { choose, interactive } from "./prompt.ts";
import { render as renderRuns, rows } from "./runs.ts";
import * as skills from "./skills.ts";
import { agentLine, attach } from "./viewer.ts";
import * as workflows from "./workflows.ts";

const usage = `wa runs one workflow as a live process, and the terminal watches it.

usage:
  wa list workflows|skills|adapters [--verbose]   show what wa can use
  wa run <workflow> [--param value ...]           start a run and watch it
  wa run <workflow> --background                  start a run and leave it alone
  wa ps                                           the live runs, and a picker to attach
  wa attach <run>                                 watch a run, with its history first
  wa install                                      set up ~/.wa and choose your skill directories
  wa sync-skills [--global|--local]               choose your skill directories again

<workflow> is a name from the list, or a path to a workflow file.
In a run: type to send a message, q detaches, Ctrl-C stops the run.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "install") {
    await install();
    return 0;
  }
  if (command === "_run") return runProcess(rest);
  const fresh = await firstRun();
  if (fresh) {
    if (command === undefined) return 0;
    say("");
  }
  if (command === "run") return runWorkflow(rest);
  if (command === "list") return listWhat(rest);
  if (command === "ps") return listRuns();
  if (command === "attach") return attachRun(rest);
  if (command === "sync-skills") return syncScopes(rest);
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return 0;
  }
  throw new WaError(`unknown command ${command}\n\n${usage}`);
}

async function listWhat(argv: string[]): Promise<number> {
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const rest = argv.filter((arg) => !arg.startsWith("-"));
  const unknown = flags.find((flag) => flag !== "--verbose" && flag !== "-v");
  if (unknown !== undefined) throw new WaError(`unknown option ${unknown}\n\n${usage}`);
  const verbose = flags.length > 0;
  const [what] = rest;
  if (what === "workflows") return listWorkflows(false, verbose);
  if (what === "skills") return listSkills(verbose);
  if (what === "adapters") return listAdapters(verbose);
  if (what === undefined) {
    throw new WaError("wa list needs a target: wa list workflows, wa list skills, or wa list adapters");
  }
  if (what === "runs") throw new WaError("wa ps shows the runs");
  throw new WaError(`wa list takes workflows, skills, or adapters, not ${what}\n\n${usage}`);
}

async function listAdapters(verbose = false): Promise<number> {
  const list = await adapters.installed(process.cwd());
  if (list.length === 0) {
    say(`no adapter file in ${adapters.searched(process.cwd()).map(short).join(" or ")}`);
    return 0;
  }
  adapters.writeEnv(process.cwd(), list);
  say(
    blocks(
      list.map((entry) => ({
        name: entry.role,
        tokens: [entry.name],
        description: entry.description,
        meta: verbose ? `${entry.scope}  ${short(entry.file)}` : "",
      })),
    ),
  );
  return 0;
}

async function listWorkflows(hint = false, verbose = false): Promise<number> {
  const list = await workflows.listed(process.cwd());
  if (list.length === 0) {
    say(`no workflow file in ${workflows.searched(process.cwd()).map(short).join(" or ")}`);
    if (hint) process.stdout.write(`\n${usage}`);
    return 0;
  }
  say(workflows.render(list, verbose));
  if (hint) say("\nrun one with: wa run <workflow> [--param value ...]");
  return 0;
}

function listSkills(verbose = false): number {
  const list = skills.available(process.cwd());
  if (list.length === 0) {
    say("no skill yet. wa sync-skills links the ones you have");
    return 0;
  }
  say(skills.render(list, verbose));
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
  const background = argv.includes("--background");
  const [target, ...rest] = argv.filter((arg) => arg !== "--background");
  if (target === undefined) return listWorkflows(true);
  const source = sourceOf(target);
  const definition = await load(source);
  const params = validate(definition.params, parseParams(definition.params, rest));
  const installed = await adapters.installed(process.cwd());
  adapters.writeEnv(process.cwd(), installed);
  const name = createRun(source, params);
  const pid = start(name);
  if (background) {
    say(`run ${name} started, ${agentLine(installed)}`);
    return 0;
  }
  return attach(name, pid);
}

function start(name: string): number {
  const entry = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [entry, "_run", name], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid ?? 0;
}

async function runProcess(argv: string[]): Promise<number> {
  const [name] = argv;
  if (name === undefined) throw new WaError("wa _run needs a run name");
  process.exit(await execute(name));
}

async function listRuns(): Promise<number> {
  const list = rows(Date.now());
  const text = renderRuns(list);
  if (!interactive() || list.length === 0) {
    say(text);
    return 0;
  }
  const [header = "", ...labels] = text.split("\n");
  const index = await choose(
    header,
    labels.map((label) => ({ label })),
    "arrows or hjkl move, enter attaches, q leaves",
  );
  const picked = index === undefined ? undefined : list[index];
  if (picked === undefined) return 0;
  return attach(picked.run);
}

async function attachRun(argv: string[]): Promise<number> {
  const [name] = argv;
  if (name === undefined) throw new WaError(`wa attach needs a run name\n\n${usage}`);
  return attach(name);
}

function sourceOf(target: string): string {
  const file = path.resolve(target);
  if (fs.existsSync(file)) return file;
  const named = workflows.locate(target, process.cwd());
  if (named !== undefined) return named;
  const places = workflows.searched(process.cwd()).join(" or ");
  throw new WaError(`no workflow file at ${file}, and no workflow named ${target} in ${places}`);
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
