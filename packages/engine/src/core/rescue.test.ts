import { expect, test } from "bun:test";
import { Fault } from "./errors.ts";
import { createRescue, worldOf } from "./rescue.ts";

type Fixes = { fixed: boolean; notes: string }[];

function harness(options: { answers?: string[]; fixes?: Fixes; noView?: boolean }) {
  const asked: string[] = [];
  const prompts: string[] = [];
  const fixes = options.fixes ?? [];
  const ctx: Record<PropertyKey, unknown> = {};
  if (options.noView !== true) {
    ctx["view"] = {
      show: () => Promise.resolve(),
      act: () => Promise.resolve(),
      ask: (text: string) => {
        asked.push(text);
        return Promise.resolve(options.answers?.[asked.length - 1] ?? "stop");
      },
    };
  }
  if (fixes.length > 0) {
    ctx["agent"] = {
      open: () => Promise.resolve("session"),
      turn: (_session: string, prompt: string) => {
        prompts.push(prompt);
        return {
          output: (async function* () {})(),
          value: Promise.resolve(fixes[prompts.length - 1] ?? { fixed: false, notes: "spent" }),
        };
      },
    };
  }
  return { asked, prompts, wrap: createRescue(worldOf(ctx)) };
}

function failing(faults: (Fault | Error)[], value = "done") {
  let calls = 0;
  return {
    calls: () => calls,
    api: {
      work: (): Promise<string> => {
        const fault = faults[calls];
        calls += 1;
        return fault === undefined ? Promise.resolve(value) : Promise.reject(fault);
      },
    },
  };
}

test("a fault waits at the gate, and retry runs the call again", async () => {
  const { asked, wrap } = harness({ answers: ["retry"] });
  const fn = failing([new Fault("the remote refused")]);

  expect(await wrap("vcs", fn.api).work()).toBe("done");
  expect(fn.calls()).toBe(2);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("vcs.work failed");
  expect(asked[0]).toContain("the remote refused");
});

test("stop ends the run on the fault itself", async () => {
  const { wrap } = harness({ answers: ["stop"] });
  const fn = failing([new Fault("the remote refused")]);

  await expect(wrap("vcs", fn.api).work()).rejects.toThrow("the remote refused");
  expect(fn.calls()).toBe(1);
});

test("a fault marked for the agent gets a fixer turn before anyone is asked", async () => {
  const { asked, prompts, wrap } = harness({ fixes: [{ fixed: true, notes: "" }] });
  const fn = failing([new Fault("the hook failed", { fix: "agent" })]);

  expect(await wrap("vcs", fn.api).work()).toBe("done");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("the hook failed");
  expect(asked).toHaveLength(0);
});

test("a fix that does not land falls through to the person with the fixer's notes", async () => {
  const { asked, wrap } = harness({
    answers: ["stop"],
    fixes: [{ fixed: false, notes: "the lockfile is from another package manager" }],
  });
  const fn = failing([new Fault("the hook failed", { fix: "agent" })]);

  await expect(wrap("vcs", fn.api).work()).rejects.toThrow("the hook failed");
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("the lockfile is from another package manager");
});

test("free text at the gate goes to the fixer as an instruction", async () => {
  const { prompts, wrap } = harness({
    answers: ["run bun install first"],
    fixes: [{ fixed: true, notes: "" }],
  });
  const fn = failing([new Fault("node_modules missing")]);

  expect(await wrap("vcs", fn.api).work()).toBe("done");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("run bun install first");
  expect(fn.calls()).toBe(2);
});

test("an error that is not a fault passes through untouched", async () => {
  const { asked, wrap } = harness({ answers: ["retry"] });
  const fn = failing([new TypeError("undefined is not a function")]);

  await expect(wrap("vcs", fn.api).work()).rejects.toThrow(TypeError);
  expect(asked).toHaveLength(0);
  expect(fn.calls()).toBe(1);
});

test("a run with no view has nobody to ask, so the fault ends it", async () => {
  const { wrap } = harness({ noView: true });
  const fn = failing([new Fault("the remote refused")]);

  await expect(wrap("vcs", fn.api).work()).rejects.toThrow("the remote refused");
  expect(fn.calls()).toBe(1);
});

test("nested apis and sync handles keep working through the wrap", async () => {
  const { wrap } = harness({});
  const api = {
    watch: { changes: () => ({ next: () => Promise.resolve("tick") }) },
    deep: { read: () => Promise.resolve(7) },
  };
  const wrapped = wrap("gh", api);
  expect(await wrapped.deep.read()).toBe(7);
  expect(await wrapped.watch.changes().next()).toBe("tick");
});
