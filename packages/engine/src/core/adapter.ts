import type { z } from "zod";
import { PenguinError } from "./errors.ts";
import type { ViewEvent } from "./message.ts";

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
};

/** What the engine hands an adapter's build function. */
export type Host = {
  /** The run's invoking folder. Relative cwd options resolve against it. */
  cwd: string;
  /** penguin's state folder, where an adapter puts what it keeps between runs. */
  state: string;
  shell(cmd: string, options?: ShellOptions): Promise<CommandResult>;
  exec(argv: string[], options?: ExecOptions): Promise<number>;
  /** Marks the run idle while the body waits on something outside penguin. */
  wait<T>(label: string, body: () => Promise<T>): Promise<T>;
  emit(event: ViewEvent): void;
  /**
   * A question for the user, the same gate a workflow asks. The run shows blocked
   * with the question until a viewer answers. An adapter asks it when only a person
   * can clear the way: sign in to a CLI, install a tool, add a remote.
   */
  gate(question: string): Promise<string>;
  gate<Shape extends z.ZodType>(question: string, shape: Shape): Promise<z.infer<Shape>>;
};

/** One prompt sent to an agent CLI, inside one session. */
export type AgentTurn = {
  session: string;
  first: boolean;
  cwd: string;
  prompt: string;
  schema?: Record<string, unknown>;
  options: Record<string, unknown>;
};

export type AgentTurnResult = { ok: true; value: unknown } | { ok: false; error: string };

/** What an adapter with the role "agent" builds. */
export type AgentAdapter = {
  turn(turn: AgentTurn): Promise<AgentTurnResult>;
};

export type Adapter<A = unknown> = {
  /** What the adapter is, on ctx: vcs, github, agent. One role, many implementations. */
  role: string;
  /** Which implementation this is: git, jira, claude. */
  name: string;
  description: string;
  /** Makes the API a workflow calls through ctx.<role>. */
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
