import type { z } from "zod";
import type { ViewEvent } from "../protocol/events.ts";

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

export type CredentialField = {
  /** The key under which the value is stored, and the key on the returned object. */
  name: string;
  /** What to show the human who types the value. */
  label: string;
  /** An environment variable that supplies the value instead. */
  env?: string;
  /** A secret value: never shown, never logged. */
  secret?: boolean;
};

export type CredentialRequest = {
  /** The name of the stored record: lowercase letters, digits, and dashes. */
  name: string;
  /** What the credential is for, shown to the human. */
  label: string;
  /** Where the human makes the key. The viewer shows it as a link. */
  url?: string;
  /** One line of extra instruction. */
  hint?: string;
  fields: readonly CredentialField[];
  /**
   * Why the provider refused the values. penguin asks the user to try again, type them
   * again, edit the file, or stop the run, then returns whatever the store holds after.
   */
  rejected?: string;
};

export type Host = {
  /** The run's invoking folder. Relative cwd options resolve against it. */
  cwd: string;
  shell(cmd: string, options?: ShellOptions): Promise<CommandResult>;
  exec(argv: string[], options?: ExecOptions): Promise<number>;
  wait<T>(label: string, body: () => Promise<T>): Promise<T>;
  emit(event: ViewEvent): void;
  /**
   * A question for the user, the same gate a workflow asks. The run shows blocked
   * with the question until a viewer answers. An adapter asks it when only a person
   * can clear the way: sign in to a CLI, install a tool, add a remote.
   */
  gate(question: string): Promise<string>;
  gate<Shape extends z.ZodType>(question: string, shape: Shape): Promise<z.infer<Shape>>;
  /**
   * The values the adapter needs from the user, one field per value. Environment
   * variables win, then the stored record. Anything still missing blocks the run
   * until a viewer takes it and writes it to the store.
   */
  credential<const R extends CredentialRequest>(
    request: R,
  ): Promise<Record<R["fields"][number]["name"], string>>;
};

export type AgentTurn = {
  session: string;
  first: boolean;
  cwd: string;
  prompt: string;
  schema?: Record<string, unknown>;
  options: Record<string, unknown>;
};

export type AgentTurnResult = { ok: true; value: unknown } | { ok: false; error: string };

export type AgentAdapter = {
  turn(turn: AgentTurn): Promise<AgentTurnResult>;
};

export type Adapter<A = unknown> = {
  role: string;
  name: string;
  description: string;
  build(host: Host): A;
};
