import { expect, test } from "bun:test";
import type { Ctx } from "penguin";
import walkthrough, { render } from "../examples/workflows/walkthrough.ts";

type Turn = { session: string; skill: string; prompt: string };

function harness(found: unknown, diff = { text: "the diff", truncated: false }) {
  const turns: Turn[] = [];
  const opens: Record<string, unknown>[] = [];
  const against: unknown[][] = [];
  const agent = {
    open: (options?: Record<string, unknown>) => {
      opens.push(options ?? {});
      return Promise.resolve(`session-${opens.length}`);
    },
    turn: (session: string, ask: { skill: string; prompt?: string }) => {
      turns.push({ session, skill: ask.skill, prompt: ask.prompt ?? "" });
      return { output: (async function* () {})(), value: Promise.resolve(found) };
    },
  };
  const vcs = {
    against: (base: string, options?: unknown) => {
      against.push([base, options]);
      return Promise.resolve(diff);
    },
  };
  const view = { show: () => Promise.resolve(), act: () => Promise.resolve() };
  const params = walkthrough.params.parse({ acceptance: "it works", base: "f00d" });
  const ctx = { params, agent, vcs, view } as unknown as Ctx<typeof params>;
  return { turns, opens, against, run: () => walkthrough.run(ctx) };
}

const found = {
  open: "http://localhost:4201/widgets",
  steps: ["Click Add Widget", "Type a name"],
  expect: "A widget with that name appears at the top of the list.",
};

test("the turn reads the change off the prompt, on a session that can only read", async () => {
  const bench = harness(found);

  await bench.run();

  expect(bench.opens).toEqual([{ tools: ["Read", "Grep", "Glob", "Bash"] }]);
  expect(bench.against).toEqual([["f00d", undefined]]);
  expect(bench.turns).toHaveLength(1);
  expect(bench.turns[0]?.skill).toBe("walkthrough");
  expect(bench.turns[0]?.prompt).toBe(
    "# What the change is for\n\nit works\n\n# The change\n\n`git diff f00d...HEAD`, read off the tree for you.\n\nthe diff",
  );
});

test("a diff cut short says so, and the turn reads the rest itself", async () => {
  const bench = harness(found, { text: "the start", truncated: true });

  await bench.run();

  expect(bench.turns[0]?.prompt).toContain("It was cut here, so read the rest with that command.");
});

test("the walkthrough comes back as the text the gate shows", async () => {
  const bench = harness(found);

  const out = await bench.run();

  expect(out).toEqual({
    walkthrough:
      "Open: http://localhost:4201/widgets\n\n1. Click Add Widget\n2. Type a name\n\nExpect: A widget with that name appears at the top of the list.",
  });
});

test("no steps leaves the open line and the expectation alone", () => {
  expect(render({ open: " bun run desktop ", steps: [], expect: "The icon is a penguin. " })).toBe(
    "Open: bun run desktop\n\nExpect: The icon is a penguin.",
  );
});
