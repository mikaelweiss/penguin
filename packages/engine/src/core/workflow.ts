import { z } from "zod";
import { messageOf, PenguinError, RunStopped } from "./errors.ts";
import type { View } from "./view.ts";

/** The roles the installed adapters put on ctx. penguin-env.d.ts merges them in. */
export interface Adapters {}

export type Ctx<Params> = { params: Params } & Adapters;

/** The engine's hook on ctx that spawns a child workflow as its own run. */
export const RUN: unique symbol = Symbol.for("penguin.run");

export type RunHooks = {
  spawn(file: string, params: unknown, cwd?: string): Promise<unknown>;
};

export type Workflow<Schema extends z.ZodObject = z.ZodObject, R = unknown> = {
  description: string;
  params: Schema;
  run(ctx: Ctx<z.infer<Schema>>): Promise<R>;
  /** The definition's own file, so call can spawn it. workflow() fills it in. */
  file?: string;
};

export function workflow<Schema extends z.ZodObject, R>(
  definition: Workflow<Schema, R>,
): Workflow<Schema, R> {
  if (typeof definition.description !== "string" || definition.description.trim() === "") {
    throw new PenguinError("a workflow needs a description");
  }
  const bare = undescribed(definition.params);
  if (bare.length > 0) {
    throw new PenguinError(
      `these params need a description, or .meta({ internal: true }) when only a caller fills them: ${bare.join(", ")}`,
    );
  }
  if (definition.file === undefined) definition.file = definitionSite();
  return definition;
}

/**
 * The params a launch form would show with nothing to label them. Read off the
 * JSON Schema a frontend renders, so this agrees with the form by construction.
 */
function undescribed(params: z.ZodObject): string[] {
  const schema = z.toJSONSchema(params) as { properties?: Record<string, unknown> };
  return Object.entries(schema.properties ?? {})
    .filter(([, value]) => {
      const property = value as Record<string, unknown>;
      return property["internal"] !== true && typeof property["description"] !== "string";
    })
    .map(([name]) => name);
}

/** The file that called workflow(), read off the stack. */
function definitionSite(): string | undefined {
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n").slice(1)) {
    const match = /(?:file:\/\/)?(\/[^)\s]+?\.(?:ts|tsx|js|jsx|mjs|cjs)):\d+:\d+\)?\s*$/.exec(line);
    const file = match?.[1];
    if (file === undefined || file.includes("/core/workflow.ts")) continue;
    return decodeURIComponent(file);
  }
  return undefined;
}

/** Where a child run works. It defaults to the folder the calling run works in. */
export type CallOptions = { cwd?: string };

/**
 * Runs a child workflow as its own run: a new process, a new run folder, the
 * child's params validated. Stopping the child rejects with RunStopped, a
 * process death without an outcome with RunCrashed, and a child that threw
 * rejects with its message. Outside an engine run it falls back to running the
 * child in place, where it shares the caller's folder.
 */
export function call<Schema extends z.ZodObject, R>(
  ctx: Ctx<unknown>,
  child: Workflow<Schema, R>,
  params: z.input<Schema>,
  options?: CallOptions,
): Promise<R> {
  const parsed = child.params.parse(params);
  const hooks = (ctx as unknown as Record<PropertyKey, unknown>)[RUN] as RunHooks | undefined;
  if (hooks === undefined || child.file === undefined) {
    if (options?.cwd !== undefined) {
      throw new PenguinError("a child that runs in place cannot take a folder of its own");
    }
    return child.run({ ...ctx, params: parsed });
  }
  return spawned(ctx, hooks, child.file, parsed, options?.cwd);
}

/** What a child that did not finish waits at. Nothing but a person ends the run that called it. */
const Again = z.enum(["again", "stop"]);

/** The view a run was wired with, when it has one. A run without it has nobody to ask. */
function watching(ctx: Ctx<unknown>): View | undefined {
  const view = (ctx as unknown as Record<string, unknown>)["view"];
  if (view === null || typeof view !== "object") return undefined;
  return typeof (view as Record<string, unknown>)["ask"] === "function" ? (view as View) : undefined;
}

/**
 * A child that died takes nothing with it. The person reads what stopped it and says whether it
 * runs again, so a run of many hours never ends on a fault somebody was there to clear.
 */
async function spawned<R>(
  ctx: Ctx<unknown>,
  hooks: RunHooks,
  file: string,
  params: unknown,
  cwd: string | undefined,
): Promise<R> {
  const name = file.split("/").pop() ?? file;
  for (;;) {
    try {
      return (await hooks.spawn(file, params, cwd)) as R;
    } catch (error) {
      const view = watching(ctx);
      // A person who stopped the child meant to stop it, and a run with no view has nobody to ask.
      if (view === undefined || error instanceof RunStopped) throw error;
      const answer = await view.ask(
        `${name} did not finish: ${messageOf(error)}\n\nClear what stopped it. again runs it once more, stop ends this run.`,
        Again,
      );
      if (answer === "stop") throw error;
    }
  }
}
