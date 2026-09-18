import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Host } from "../src/core/adapter.ts";
import definition from "../examples/adapters/jev.ts";

type Note = Record<string, unknown>;
type Sent = { state: Record<string, unknown>; questions: Record<string, unknown> };

let temps: string[] = [];
let held: string | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  held = process.env["TYPESAFE_API_KEY"];
  process.env["TYPESAFE_API_KEY"] = "good";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (held === undefined) delete process.env["TYPESAFE_API_KEY"];
  else process.env["TYPESAFE_API_KEY"] = held;
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

function fakeHost(): { host: Host; notes: Note[] } {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-jev-"));
  temps.push(state);
  const notes: Note[] = [];
  const host: Host = {
    cwd: "/",
    home: "/tmp",
    state,
    run: { id: "test", dir: state },
    config: () => undefined,
    secret: async () => undefined,
    note: (entry) => notes.push(entry),
    open: () => {},
    skill: () => {
      throw new Error("no skills installed");
    },
    spawn: () => {
      throw new Error("no spawn in this test");
    },
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
  return { host, notes };
}

/** Answers every question by its kind: nouls from `nouls`, choices from `choices`, both by question id. */
function fakeFetch(nouls: Record<string, number>, choices: Record<string, string> = {}): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Sent;
    sent.push(body);
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(body.questions)) {
      const kind = (question as { type: string }).type;
      if (kind === "noul") answers[id] = { noul: nouls[id] ?? 0 };
      if (kind === "choice") answers[id] = { choice: choices[id] ?? "other", probabilities: {}, confidence: 0.9 };
    }
    return Response.json({ model: "jev-latest", answers, usage: { input_tokens: 10, output_tokens: 1 } });
  }) as typeof fetch;
  return sent;
}

function jev() {
  const fake = fakeHost();
  return { ...fake, jev: definition.build(fake.host) };
}

const SMALL = "+++ b/README.md\n@@ -1 +1 @@\n-Penguin\n+penguin";

const pr = { title: "fix a typo", description: "lowercase the name", notes: [] };

test("a diff past the size a person reads never reaches Jev", async () => {
  const bench = jev();
  const sent = fakeFetch({});
  const wide = Array.from({ length: 6 }, (_, at) => `+++ b/src/${at}.ts\n+x`).join("\n");
  const long = `+++ b/src/a.ts\n${Array.from({ length: 101 }, () => "+x").join("\n")}`;

  expect(await bench.jev.triage.pr({ ...pr, diff: wide })).toEqual({ eyeball: false, reason: "6 files change" });
  expect(await bench.jev.triage.pr({ ...pr, diff: long })).toEqual({ eyeball: false, reason: "101 lines change" });
  expect(sent).toEqual([]);
});

test("a small plain change is one to eyeball, and the reason counts it", async () => {
  const bench = jev();
  const sent = fakeFetch({ traced: 0.05, reaches: 0.1, risky: 0.02, plain: 0.95 });

  const said = await bench.jev.triage.pr({ ...pr, diff: SMALL });

  expect(said).toEqual({ eyeball: true, reason: "1 file and 2 changed lines doing one plain thing" });
  expect(sent[0]?.state).toEqual({
    pr: { title: "fix a typo", description: "lowercase the name", comments: [] },
    diff: SMALL,
  });
  expect(Object.keys(sent[0]?.questions ?? {})).toEqual(["traced", "reaches", "risky", "plain"]);
  expect(bench.notes[0]).toMatchObject({ usage: { adapter: "jev", input: 10, output: 1 } });
});

test("the strongest reason for the full review names it, over a plain-looking change", async () => {
  const bench = jev();
  fakeFetch({ traced: 0.35, reaches: 0.1, risky: 0.6, plain: 0.9 });

  const said = await bench.jev.triage.pr({ ...pr, diff: SMALL });

  expect(said).toEqual({ eyeball: false, reason: "it touches security, permissions, money, or data loss" });
});

test("a change with no risk that still does more than one thing gets the full review", async () => {
  const bench = jev();
  fakeFetch({ traced: 0.1, reaches: 0.1, risky: 0.1, plain: 0.4 });

  const said = await bench.jev.triage.pr({ ...pr, diff: SMALL });

  expect(said).toEqual({ eyeball: false, reason: "it does more than one plain thing" });
});

test("a ticket whose goal is clear is actionable, and Jev reads it whole", async () => {
  const bench = jev();
  const sent = fakeFetch({ clear: 0.9 }, { missing: "other" });

  const said = await bench.jev.triage.ticket({ ticket: "add a toggle that hides completed items" });

  expect(said).toEqual({ actionable: true, reason: "the goal is clear enough to build" });
  expect(sent[0]?.state).toEqual({ ticket: "add a toggle that hides completed items" });
  expect(Object.keys(sent[0]?.questions ?? {})).toEqual(["clear", "missing"]);
});

test("a ticket that is not clear says what it leaves open", async () => {
  const bench = jev();
  fakeFetch({ clear: 0.2 }, { missing: "goal" });

  const said = await bench.jev.triage.ticket({ ticket: "make it better" });

  expect(said).toEqual({ actionable: false, reason: "it says no outcome" });
});

test("feedback that directs the author asks, and the strongest fact says how", async () => {
  const bench = jev();
  const sent = fakeFetch({ direction: 0.8, question: 0.2, requestChanges: 0.1, blocking: 0.9 }, { remark: "approval" });

  const said = await bench.jev.triage.feedback({ author: "ana", text: "ana commented:\n\nAdd coverage before this merges" });

  expect(said).toEqual({ asks: true, why: "it marks something as required before merge" });
  expect(sent[0]?.state).toEqual({
    feedback: { author: "ana", text: "ana commented:\n\nAdd coverage before this merges" },
  });
});

test("feedback that directs nothing asks nothing, and the remark's kind says why", async () => {
  const bench = jev();
  fakeFetch({ direction: 0.1, question: 0.05, requestChanges: 0.0, blocking: 0.02 }, { remark: "botStatus" });

  const said = await bench.jev.triage.feedback({ author: "vercel", text: "vercel commented:\n\nPreview is live" });

  expect(said).toEqual({ asks: false, why: "it is a bot's status line" });
});
