import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { Fault, messageOf } from "./errors.ts";
import type { View } from "./view.ts";

/**
 * The engine's default recovery for adapter calls. A call that throws a Fault
 * holds the run at a gate instead of ending it: a fault marked for the agent
 * gets a bounded number of fixer turns first, then the person reads what
 * stopped the call and says whether it runs again. A workflow that wants its
 * own handling catches the Fault itself; everything it does not catch lands
 * here. Errors that are not Faults pass through untouched.
 */

const FIXES = 3;

const bare = new AsyncLocalStorage<boolean>();

/**
 * Runs the job with the engine's fault gate off, so a Fault reaches the caller
 * to handle itself. For the rare call whose failure the workflow genuinely
 * answers differently: a best-effort teardown, a freshness probe inside a
 * watch. Everything else belongs outside attempt, where the gate does its job.
 */
export function attempt<T>(job: () => Promise<T>): Promise<T> {
  return bare.run(true, job);
}

const Fixed = z.object({
  fixed: z.boolean().describe("true when the cause is cleared and the call is worth another try"),
  notes: z.string().describe("what stopped the call, and what a person has to do when it is not fixed"),
});

const Gate = z.union([z.enum(["retry", "stop"]), z.string()]);
const Bare = z.enum(["retry", "stop"]);

type Chunk = { kind: string; text?: string; call?: { id: string; name: string; status: string } };

type FixTurn = { output: AsyncIterable<Chunk>; value: Promise<unknown> };

/** The de facto agent contract every agent adapter builds. Read off ctx when a fault needs one. */
type Fixer = {
  open(): Promise<string>;
  turn(session: string, ask: string, options: { result: z.ZodObject }): FixTurn;
};

/** What the ladder reaches for at fault time, read fresh so wiring order does not matter. */
export type World = {
  view(): View | undefined;
  agent(): Fixer | undefined;
};

/** Reads the view and agent roles off a ctx object, duck-typed and safe when absent. */
export function worldOf(ctx: Record<PropertyKey, unknown>): World {
  return {
    view: () => {
      const view = ctx["view"];
      if (view === null || typeof view !== "object") return undefined;
      return typeof (view as View).ask === "function" ? (view as View) : undefined;
    },
    agent: () => {
      const agent = ctx["agent"];
      if (agent === null || typeof agent !== "object") return undefined;
      const api = agent as Fixer;
      return typeof api.open === "function" && typeof api.turn === "function" ? api : undefined;
    },
  };
}

export function createRescue(world: World): <A>(role: string, api: A) => A {
  let session = "";

  /** One fixer turn, its stream shown as it runs. A turn that dies is a fix that did not land. */
  async function fixing(view: View, prompt: string): Promise<z.infer<typeof Fixed>> {
    const agent = world.agent();
    if (agent === undefined) return { fixed: false, notes: "no agent is installed" };
    try {
      if (session === "") session = await agent.open();
      const turn = agent.turn(session, prompt, { result: Fixed });
      const shown = (async () => {
        for await (const chunk of turn.output) {
          if (chunk.kind === "text" && chunk.text !== undefined) await view.show(chunk.text);
          if (chunk.kind === "tool" && chunk.call !== undefined) {
            await view.act(chunk.call as Parameters<View["act"]>[0]);
          }
        }
      })();
      const value = await turn.value;
      await shown;
      return Fixed.parse(value);
    } catch (error) {
      return { fixed: false, notes: `The fixer did not answer: ${messageOf(error)}` };
    }
  }

  /**
   * The gate an unfixed fault waits at. Retry runs the call again, stop ends the
   * run on the fault, and anything else goes to the fixer as an instruction.
   */
  async function gated(view: View, name: string, reason: string): Promise<boolean> {
    const agent = world.agent();
    let said = reason;
    for (;;) {
      const extra = agent === undefined ? "" : " Anything else goes to a fixer agent.";
      const answer = await view.ask(
        `${name} failed:\n\n${said}\n\nClear what stopped it and type retry to run it again, or stop to end the run.${extra}`,
        agent === undefined ? Bare : Gate,
      );
      if (answer === "stop") return false;
      if (answer === "retry") return true;
      const fix = await fixing(
        view,
        `The call ${name} failed:\n\n${said}\n\nThe user says:\n\n${answer}\n\nAnswer it and act on it.`,
      );
      if (fix.fixed) return true;
      said = fix.notes;
    }
  }

  /** Whether the call runs again. Throws the fault when the person ends the run on it. */
  async function held(name: string, fault: Fault, agentTries: number): Promise<boolean> {
    const view = world.view();
    if (view === undefined) throw fault;
    if (fault.fix === "agent" && agentTries <= FIXES && world.agent() !== undefined) {
      const fix = await fixing(
        view,
        `The call ${name} failed:\n\n${fault.message}\n\nFix what stopped it. A fix that changes files the branch should carry gets committed with git. Never weaken a check to pass it: no --no-verify, no editing hooks, no deleting tests. Say fixed only when the cause is cleared and the call is worth another try.`,
      );
      if (fix.fixed) return true;
      if (!(await gated(view, name, fix.notes))) throw fault;
      return true;
    }
    if (!(await gated(view, name, fault.message))) throw fault;
    return true;
  }

  function guarded(name: string, fn: (...args: unknown[]) => unknown, self: unknown) {
    return (...args: unknown[]): unknown => {
      const first = fn.apply(self, args);
      if (!(first instanceof Promise)) return first;
      if (bare.getStore() === true) return first;
      return (async () => {
        let agentTries = 0;
        let result = first;
        for (;;) {
          try {
            return await result;
          } catch (error) {
            if (!(error instanceof Fault)) throw error;
            agentTries += 1;
            await held(name, error, agentTries);
            result = fn.apply(self, args) as Promise<unknown>;
          }
        }
      })();
    };
  }

  function walk(prefix: string, api: unknown): unknown {
    if (api === null || typeof api !== "object") return api;
    const wrapped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(api)) {
      const name = prefix === "" ? key : `${prefix}.${key}`;
      if (typeof value === "function") {
        wrapped[key] = guarded(name, value as (...args: unknown[]) => unknown, api);
      } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        wrapped[key] = walk(name, value);
      } else {
        wrapped[key] = value;
      }
    }
    return wrapped;
  }

  return <A>(role: string, api: A): A => walk(role, api) as A;
}
