import { PenguinError } from "./errors.ts";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type ShellOptions = {
  cwd?: string;
  stdin?: string;
};

export type ExecOptions = ShellOptions & {
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
};

/** Where a run's files live: run.jsonl written by the run, inbox.jsonl written by frontends. */
export type RunLocation = {
  id: string;
  dir: string;
};

/** One skill from a catalog: a folder holding a SKILL.md in the Agent Skills format. */
export type Skill = {
  name: string;
  description: string;
  /** The skill's folder, where its extra files live. */
  dir: string;
  /** The SKILL.md body, the instructions. */
  text: string;
};

/** What the engine hands an adapter's build function. */
export type Host = {
  /** The run's invoking folder. Relative cwd options resolve against it. */
  cwd: string;
  /** penguin's home folder, ~/.penguin: config, catalogs, worktrees. */
  home: string;
  /** penguin's state folder, where an adapter puts what it keeps between runs. */
  state: string;
  /** This run's id and folder. */
  run: RunLocation;
  /** One value from ~/.penguin/config, or undefined when the key has no line. */
  config(key: string): string | undefined;
  /** One secret from the machine keystore, or undefined when unset or unsupported. */
  secret(name: string): Promise<string | undefined>;
  /** Appends one stamped line to the run's file, for frontends to read. */
  note(entry: Record<string, unknown>): void;
  /** One skill from the run's catalogs, project first. Throws when no catalog holds the name. */
  skill(name: string): Skill;
  /** Runs one string through a real shell. For constant strings and shell features, never interpolation. */
  shell(cmd: string, options?: ShellOptions): Promise<CommandResult>;
  /** Spawns an argv directly, so arguments need no quoting. Aborting the signal kills the process. */
  exec(argv: string[], options?: ExecOptions): Promise<CommandResult>;
};

export type Adapter<A = unknown> = {
  /** What the adapter is, on ctx: vcs, github, agent, view. One role, many implementations. */
  role: string;
  /** Which implementation this is: git, jira, claude, terminal. */
  name: string;
  description: string;
  /** Makes the API a workflow calls through ctx.<role>. Plain data in, plain data, streams, or handles of those out. */
  build(host: Host): A;
};

export function adapter<A>(definition: Adapter<A>): Adapter<A> {
  for (const field of ["role", "name", "description"] as const) {
    if (typeof definition[field] !== "string" || definition[field].trim() === "") {
      throw new PenguinError(`an adapter needs a ${field}`);
    }
  }
  if (typeof definition.build !== "function") {
    throw new PenguinError("an adapter needs a build function");
  }
  return definition;
}
