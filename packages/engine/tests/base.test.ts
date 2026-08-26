import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import { resolveBase } from "../examples/helpers/base.ts";

type Default = { ok: boolean; branch: string; reason: string };

function stub(
  fallback: Default,
  answers: string[],
): { ctx: Ctx<unknown>; defaults: () => number; asks: string[] } {
  let defaults = 0;
  const asks: string[] = [];
  const ctx = {
    vcs: {
      defaultBranch: () => {
        defaults += 1;
        return Promise.resolve(fallback);
      },
    },
    view: {
      ask: (question: string) => {
        asks.push(question);
        return Promise.resolve(answers.shift() ?? "");
      },
    },
  } as unknown as Ctx<unknown>;
  return { ctx, defaults: () => defaults, asks };
}

test("a base the caller named wins, and origin is never read", async () => {
  const { ctx, defaults, asks } = stub({ ok: true, branch: "main", reason: "" }, []);
  expect(await resolveBase(ctx, "  release  ")).toBe("release");
  expect(defaults()).toBe(0);
  expect(asks).toEqual([]);
});

test("an empty base takes the branch origin calls default, with nothing asked", async () => {
  const { ctx, asks } = stub({ ok: true, branch: "trunk", reason: "" }, []);
  expect(await resolveBase(ctx, "")).toBe("trunk");
  expect(asks).toEqual([]);
});

test("an unset origin/HEAD asks for a branch instead of guessing main", async () => {
  const { ctx, asks } = stub({ ok: false, branch: "", reason: "no upstream" }, [" release-2 "]);
  expect(await resolveBase(ctx, "")).toBe("release-2");
  expect(asks).toHaveLength(1);
});

test("stop at the ask answers with no base at all", async () => {
  const { ctx } = stub({ ok: false, branch: "", reason: "no upstream" }, ["stop"]);
  expect(await resolveBase(ctx, "")).toBe("");
});
