import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { roots, type Catalog } from "./catalog/catalogs.ts";
import { locateSkill, readSkill, skillsIn } from "./catalog/skills.ts";
import { readConfig } from "./config.ts";
import type { CommandResult, ExecOptions, Host, RunLocation } from "./core/adapter.ts";
import { PenguinError } from "./core/errors.ts";
import { home, stateRoot } from "./paths.ts";

export function createHost(cwd: string, location: RunLocation, catalogs?: Catalog[]): Host {
  const resolve = (relative: string | undefined): string => path.resolve(cwd, relative ?? ".");
  const settings = readConfig();
  const list = (): Catalog[] => catalogs ?? roots(cwd);
  return {
    cwd,
    home: home(),
    state: stateRoot(),
    run: location,
    config: (key) => settings.get(key),
    skill: (name) => {
      const found = locateSkill(name, list());
      if (found === undefined) {
        const names = skillsIn(list())
          .map((entry) => entry.name)
          .join(", ");
        throw new PenguinError(
          names === ""
            ? `no skill named ${name} is installed`
            : `no skill named ${name}. Installed: ${names}`,
        );
      }
      return readSkill(found.dir);
    },
    shell: (cmd, options) => run(cmd, undefined, resolve(options?.cwd), options),
    exec: (argv, options) => {
      const [cmd, ...args] = argv;
      if (cmd === undefined) throw new PenguinError("exec needs a command");
      return run(cmd, args, resolve(options?.cwd), options);
    },
  };
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
