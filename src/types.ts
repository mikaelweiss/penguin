import type { z } from "zod";

export type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type AgentOptions = {
  input?: string;
  agent?: string;
  cwd?: string;
};

export type CommandOptions = {
  cwd?: string;
};

export interface Step {
  agent<R extends z.ZodObject>(
    skill: string,
    options: AgentOptions & { result: R },
  ): Promise<z.infer<R>>;
  agent(skill: string, options?: AgentOptions): Promise<void>;
  command(cmd: string, options?: CommandOptions): Promise<CommandResult>;
}

export type Ctx<Params> = {
  params: Params;
  step: Step;
  gate(question: string): Promise<string>;
};

export type Workflow<Schema extends z.ZodObject = z.ZodObject> = {
  params: Schema;
  run(ctx: Ctx<z.infer<Schema>>): Promise<void>;
};
