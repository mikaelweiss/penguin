#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRun } from "./create.ts";
import { type Outcome, execute } from "./engine.ts";
import { messageOf, WaError } from "./errors.ts";
import { render, rows } from "./list.ts";
import { load } from "./loader.ts";
import { parseParams, validate } from "./params.ts";

const usage = `wa runs one workflow file as a foreground process.

usage:
  wa run <workflow.ts> [--param value ...]   validate params, create the run, execute it
  wa resume <run> [reply]                    replay the journal, then continue
  wa list                                    show every run
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "run") return runWorkflow(rest);
  if (command === "resume") return resumeRun(rest);
  if (command === "list") {
    process.stdout.write(`${render(rows(Date.now()))}\n`);
    return 0;
  }
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(usage);
    return 0;
  }
  throw new WaError(`unknown command ${command}\n\n${usage}`);
}

async function runWorkflow(argv: string[]): Promise<number> {
  const [file, ...rest] = argv;
  if (file === undefined) throw new WaError(`wa run needs a workflow file\n\n${usage}`);
  const source = path.resolve(file);
  if (!fs.existsSync(source)) throw new WaError(`no workflow file at ${source}`);
  const definition = await load(source);
  const params = validate(definition.params, parseParams(definition.params, rest));
  const name = createRun(source, params);
  process.stdout.write(`run ${name}\n`);
  return code(await execute(name));
}

async function resumeRun(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined) throw new WaError(`wa resume needs a run name\n\n${usage}`);
  const reply = rest.length > 0 ? rest.join(" ") : undefined;
  process.stdout.write(`run ${name}\n`);
  return code(await execute(name, reply));
}

function code(outcome: Outcome): number {
  return outcome === "failed" ? 1 : 0;
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
