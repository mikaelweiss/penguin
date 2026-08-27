import { secrets } from "bun";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readConfig } from "./config.ts";
import type { CommandResult, ExecOptions, Host, RunLocation, Skill } from "./core/adapter.ts";
import { PenguinError } from "./core/errors.ts";
import { home, stateRoot } from "./paths.ts";

/** Resolves a skill by name. The caller owns which catalogs are in play. */
export type SkillLookup = (name: string) => Skill;

export function createHost(cwd: string, location: RunLocation, skill: SkillLookup): Host {
  const resolve = (relative: string | undefined): string => path.resolve(cwd, relative ?? ".");
  const settings = readConfig();
  const opened = new Set<string>();
  const note = (entry: Record<string, unknown>): void => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    fs.appendFileSync(path.join(location.dir, "run.jsonl"), `${line}\n`);
  };
  return {
    cwd,
    home: home(),
    state: stateRoot(),
    run: location,
    config: (key) => settings.get(key),
    secret: (name) => readSecret(name),
    note,
    // An adapter opens what it produces, and a watch loop asks it again on every poll.
    open: (url) => {
      if (!isWeb(url) || opened.has(url)) return;
      opened.add(url);
      note({ open: url });
    },
    skill,
    shell: (cmd, options) => run(cmd, undefined, resolve(options?.cwd), options),
    exec: (argv, options) => {
      const [cmd, ...args] = argv;
      if (cmd === undefined) throw new PenguinError("exec needs a command");
      return run(cmd, args, resolve(options?.cwd), options);
    },
  };
}

/** A page a browser can show. An adapter that came up empty hands over "", not a url. */
function isWeb(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The keystore item store-secret.ts writes, read by the same binary that wrote it. */
async function readSecret(name: string): Promise<string | undefined> {
  try {
    return (await secrets.get({ service: "penguin", name })) ?? undefined;
  } catch {
    return undefined;
  }
}

function run(
  cmd: string,
  args: string[] | undefined,
  cwd: string,
  options?: ExecOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const stdio: ("ignore" | "pipe")[] = [
      options?.stdin === undefined ? "ignore" : "pipe",
      "pipe",
      "pipe",
    ];
    const child: ChildProcess =
      args === undefined
        ? spawn(cmd, { shell: true, cwd, stdio })
        : spawn(cmd, args, { cwd, stdio });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      options?.onOutput?.(text, "stdout");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      options?.onOutput?.(text, "stderr");
    });
    if (options?.stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(options.stdin);
    }
    const stop = (): void => {
      child.kill();
    };
    options?.signal?.addEventListener("abort", stop, { once: true });
    if (options?.signal?.aborted === true) stop();
    child.on("error", (error) => {
      options?.signal?.removeEventListener("abort", stop);
      reject(error);
    });
    child.on("close", (code) => {
      options?.signal?.removeEventListener("abort", stop);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
