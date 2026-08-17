#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { z } from "zod";
import * as adapters from "./adapters.ts";
import { pasteImage } from "./clipboard.ts";
import { allocateRun, createRun, discardRun, finishRun } from "./create.ts";
import { ask } from "./editor.ts";
import { execute } from "./engine.ts";
import { messageOf, PenguinError } from "./errors.ts";
import { firstRun, install, syncSkills } from "./install.ts";
import { blocks } from "./layout.ts";
import { load } from "./loader.ts";
import { type Asked, coerce, parseParams, unfilled, validate } from "./params.ts";
import { attachmentsDir, type Scope, short } from "./paths.ts";
import { choose, control, interactive } from "./prompt.ts";
import { render as renderRuns, rows } from "./runs.ts";
import * as skills from "./skills.ts";
import { agentLine, attach } from "./viewer.ts";
import * as workflows from "./workflows.ts";

const usage = `penguin runs one workflow as a live process, and the terminal watches it.

usage:
  pn list workflows|skills|adapters [--verbose]   show what penguin can use
  pn run <workflow> [--param value ...]           start a run and watch it
  pn run <workflow> -i                            ask for the params the args did not fill
  pn run <workflow> --background                  start a run and leave it alone
  pn ps                                           the live runs, and a picker to attach
  pn attach <run>                                 watch a run, with its history first
  pn install                                      set up ~/.penguin and choose your skill directories
  pn sync-skills [--global|--local]               choose your skill directories again

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
  throw new PenguinError(`unknown command ${command}\n\n${usage}`);
}

async function listWhat(argv: string[]): Promise<number> {
  const flags = argv.filter((arg) => arg.startsWith("-"));
  const rest = argv.filter((arg) => !arg.startsWith("-"));
  const unknown = flags.find((flag) => flag !== "--verbose" && flag !== "-v");
  if (unknown !== undefined) throw new PenguinError(`unknown option ${unknown}\n\n${usage}`);
  const verbose = flags.length > 0;
  const [what] = rest;
  if (what === "workflows") return listWorkflows(false, verbose);
  if (what === "skills") return listSkills(verbose);
  if (what === "adapters") return listAdapters(verbose);
  if (what === undefined) {
    throw new PenguinError("pn list needs a target: pn list workflows, pn list skills, or pn list adapters");
  }
  if (what === "runs") throw new PenguinError("pn ps shows the runs");
  throw new PenguinError(`pn list takes workflows, skills, or adapters, not ${what}\n\n${usage}`);
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
  if (hint) say("\nrun one with: pn run <workflow> [--param value ...]");
  return 0;
}

function listSkills(verbose = false): number {
  const list = skills.available(process.cwd());
  if (list.length === 0) {
    say("no skill yet. pn sync-skills links the ones you have");
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
  throw new PenguinError(`unknown option ${flag}\n\n${usage}`);
}

async function runWorkflow(argv: string[]): Promise<number> {
  const background = argv.includes("--background");
  const asked = argv.includes("-i") || argv.includes("--interactive");
  const [target, ...rest] = argv.filter(
    (arg) => arg !== "--background" && arg !== "-i" && arg !== "--interactive",
  );
  if (target === undefined) return listWorkflows(true);
  const source = sourceOf(target);
  const definition = await load(source);
  const values = parseParams(definition.params, rest);
  if (asked && !interactive()) throw new PenguinError("pn run -i needs a terminal");
  const installed = await adapters.installed(process.cwd());
  adapters.writeEnv(process.cwd(), installed);
  const name = asked
    ? await startAsked(source, definition.params, values)
    : createRun(source, checkedParams(definition.params, values, target));
  const pid = start(name);
  if (background) {
    say(`run ${name} started, ${agentLine(installed)}`);
    return 0;
  }
  return attach(name, pid);
}

function checkedParams(
  schema: z.ZodObject,
  values: Record<string, unknown>,
  target: string,
): unknown {
  try {
    return validate(schema, values);
  } catch (error) {
    if (error instanceof PenguinError && interactive()) {
      throw new PenguinError(`${error.message}\n  pn run ${target} -i asks for anything missing`);
    }
    throw error;
  }
}

/** The run directory exists first, so a pasted image lands in its attachments. */
async function startAsked(
  source: string,
  schema: z.ZodObject,
  values: Record<string, unknown>,
): Promise<string> {
  const { name, dir } = allocateRun(source);
  const leave = (): void => {
    discardRun(dir);
    process.stdout.write("\x1b[?2004l\n");
    process.exit(130);
  };
  try {
    for (const param of unfilled(schema, values)) {
      await fillParam(param, values, attachmentsDir(dir), leave);
    }
    validate(schema, values);
    finishRun(dir, source, values);
    return name;
  } catch (error) {
    discardRun(dir);
    throw error;
  }
}

async function fillParam(
  param: Asked,
  values: Record<string, unknown>,
  attachments: string,
  interrupt: () => void,
): Promise<void> {
  const question = `--${param.name} <${param.hint}>`;
  if (param.choices.length > 0) {
    const labels = param.optional ? [...param.choices, "skip"] : param.choices;
    const running = control(
      question,
      labels.map((label) => ({ label })),
      { many: false, interrupt },
    );
    const picked = (await running.picked)?.[0];
    if (picked !== undefined && picked < param.choices.length) {
      values[param.name] = param.choices[picked] ?? "";
    }
    return;
  }
  for (;;) {
    const answer = await ask(question, {
      notes: param.optional ? ["enter skips"] : [],
      attach: () => pasteImage(attachments),
      interrupt,
    });
    if (answer === "") {
      if (param.optional) return;
      continue;
    }
    try {
      values[param.name] = coerce(param.kind, param.name, answer);
      return;
    } catch (error) {
      say(messageOf(error));
    }
  }
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
  if (name === undefined) throw new PenguinError("pn _run needs a run name");
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
  if (name === undefined) throw new PenguinError(`pn attach needs a run name\n\n${usage}`);
  return attach(name);
}

function sourceOf(target: string): string {
  const file = path.resolve(target);
  if (fs.existsSync(file)) return file;
  const named = workflows.locate(target, process.cwd());
  if (named !== undefined) return named;
  const places = workflows.searched(process.cwd()).join(" or ");
  throw new PenguinError(`no workflow file at ${file}, and no workflow named ${target} in ${places}`);
}

function say(text: string): void {
  process.stdout.write(`${text}\n`);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`pn: ${messageOf(error)}\n`);
  if (!(error instanceof PenguinError) && error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exitCode = 1;
}
