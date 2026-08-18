import assert from "node:assert/strict";
import test from "node:test";
import { type ViewEvent } from "@mikaelweiss/penguin-engine";
import { Projection } from "@mikaelweiss/penguin-viewer";

/** A JSON round trip drops an undefined field, so the builders never set one. */
function clean(event: Record<string, unknown>): ViewEvent {
  for (const key of Object.keys(event)) {
    if (event[key] === undefined) delete event[key];
  }
  return event as ViewEvent;
}

function start(id: string, label: string, parent?: string, detail?: string): ViewEvent {
  return clean({ type: "activity", phase: "start", id, label, parent, detail });
}

function finish(id: string, outcome: "ok" | "failed"): ViewEvent {
  return clean({ type: "activity", phase: "end", id, outcome });
}

function stepStart(id: string, label: string, activity?: string): ViewEvent {
  return clean({ type: "step", phase: "start", id, label, activity });
}

function stepEnd(id: string, label: string, ok: boolean, activity?: string): ViewEvent {
  return clean({ type: "step", phase: "end", id, label, ok, activity });
}

function waitStart(id: string, label: string, activity?: string): ViewEvent {
  return clean({ type: "wait", phase: "start", id, label, activity });
}

function waitEnd(id: string, activity?: string): ViewEvent {
  return clean({ type: "wait", phase: "end", id, activity });
}

function ask(id: string, question: string, activity?: string, schema?: Record<string, unknown>): ViewEvent {
  return clean({ type: "gate", phase: "asked", id, question, schema, activity });
}

function answer(id: string, question: string, text: string, activity?: string): ViewEvent {
  return clean({ type: "gate", phase: "answered", id, question, answer: text, activity });
}

function session(id: string, name: string, activity?: string, dir = "/work"): ViewEvent {
  return clean({ type: "session", id, name, use: "claude", dir, activity });
}

function made(name: string, cwd = "/work"): Projection {
  return new Projection(name, cwd);
}

function agent(sessionId: string, text: string, activity?: string): ViewEvent {
  return clean({ type: "agent", session: sessionId, kind: "text", text, activity });
}

function feed(projection: Projection, events: ViewEvent[]): void {
  for (const event of events) projection.apply(event);
}

function stateOf(projection: Projection, id: string): string {
  const node = projection.node(id);
  assert.ok(node !== undefined, `node ${id} is missing`);
  return node.state;
}

function kinds(entries: { event: ViewEvent }[]): string[] {
  return entries.map((entry) => entry.event.type);
}

const nested: ViewEvent[] = [
  start("a", "build"),
  start("a1", "compile", "a"),
  start("a2", "review", "a"),
  start("b", "deploy"),
];

test("subtree precedence picks running over blocked over idle", () => {
  const projection = made("demo");
  feed(projection, nested);
  assert.equal(stateOf(projection, "root"), "quiet");

  feed(projection, [stepStart("s1", "tsc", "a1")]);
  assert.equal(stateOf(projection, "a1"), "running");
  assert.equal(stateOf(projection, "a"), "running");
  assert.equal(stateOf(projection, "root"), "running");

  feed(projection, [ask("g1", "ship it?", "a2")]);
  assert.equal(stateOf(projection, "a2"), "blocked");
  assert.equal(stateOf(projection, "a"), "running");

  feed(projection, [waitStart("w1", "poll ci", "b")]);
  assert.equal(stateOf(projection, "b"), "idle");
  assert.equal(stateOf(projection, "root"), "running");

  feed(projection, [stepEnd("s1", "tsc", true, "a1")]);
  assert.equal(stateOf(projection, "a1"), "quiet");
  assert.equal(stateOf(projection, "a"), "blocked");
  assert.equal(stateOf(projection, "root"), "blocked");

  feed(projection, [answer("g1", "ship it?", "yes", "a2")]);
  assert.equal(stateOf(projection, "a"), "quiet");
  assert.equal(stateOf(projection, "root"), "idle");

  feed(projection, [waitEnd("w1", "b")]);
  assert.equal(stateOf(projection, "root"), "quiet");
});

test("an end outcome names the node state, and an ended child never ends its parent", () => {
  const projection = made("demo");
  feed(projection, nested);
  feed(projection, [finish("a1", "ok"), finish("a2", "failed")]);
  assert.equal(stateOf(projection, "a1"), "done");
  assert.equal(stateOf(projection, "a2"), "failed");
  assert.equal(stateOf(projection, "a"), "quiet");
  assert.equal(projection.node("a")?.ended, undefined);

  feed(projection, [finish("a", "ok")]);
  assert.equal(stateOf(projection, "a"), "done");
  assert.equal(stateOf(projection, "root"), "quiet");
});

test("an open step outranks an ended activity", () => {
  const projection = made("demo");
  feed(projection, [start("a", "build"), start("a1", "compile", "a"), stepStart("s1", "tsc", "a1"), finish("a", "ok")]);
  assert.equal(stateOf(projection, "a"), "running");
  feed(projection, [stepEnd("s1", "tsc", true, "a1")]);
  assert.equal(stateOf(projection, "a"), "done");
});

test("the tree keeps first-seen child order in preorder", () => {
  const projection = made("demo");
  feed(projection, nested);
  assert.deepEqual(
    projection.tree().map((node) => node.id),
    ["root", "a", "a1", "a2", "b"],
  );
  assert.deepEqual(projection.root().children, ["a", "b"]);
  assert.equal(projection.root().label, "demo");
});

test("a gate opens on ask and closes on the answer with the same id", () => {
  const projection = made("demo");
  feed(projection, [start("a", "review"), ask("g1", "merge?", "a", { type: "boolean" })]);
  const open = projection.attention();
  assert.equal(open.length, 1);
  const first = open[0];
  assert.ok(first !== undefined);
  assert.equal(first.kind, "gate");
  assert.equal(first.gate, "g1");
  assert.equal(first.question, "merge?");
  assert.deepEqual(first.schema, { type: "boolean" });
  assert.equal(first.node, "a");
  assert.deepEqual(first.path, ["demo", "review"]);

  feed(projection, [answer("g1", "merge?", "yes", "a")]);
  assert.deepEqual(projection.attention(), []);
  assert.equal(stateOf(projection, "a"), "quiet");
});

test("a re-ask with the same id updates one attention entry", () => {
  const projection = made("demo");
  feed(projection, [
    ask("g1", "how many?", undefined, { type: "number" }),
    ask("g2", "which branch?"),
    ask("g1", "how many? (a number)", undefined, { type: "integer" }),
  ]);
  const open = projection.attention();
  assert.equal(open.length, 2);
  assert.deepEqual(
    open.map((item) => (item.kind === "gate" ? item.gate : item.name)),
    ["g1", "g2"],
  );
  const first = open[0];
  assert.ok(first !== undefined && first.kind === "gate");
  assert.equal(first.question, "how many? (a number)");
  assert.deepEqual(first.schema, { type: "integer" });
  assert.equal(stateOf(projection, "root"), "blocked");

  feed(projection, [answer("g1", "how many? (a number)", "3")]);
  assert.equal(projection.attention().length, 1);
  assert.equal(stateOf(projection, "root"), "blocked");
  feed(projection, [answer("g2", "which branch?", "main")]);
  assert.deepEqual(projection.attention(), []);
  assert.equal(stateOf(projection, "root"), "quiet");
});

test("a credential goes asked to rejected to ready", () => {
  const projection = made("demo");
  const fields = [{ name: "token", label: "API token", secret: true, env: "JIRA_TOKEN" }];
  projection.apply({
    type: "credential",
    phase: "asked",
    name: "jira",
    label: "Jira",
    url: "https://jira.example",
    hint: "make a token",
    fields,
  });
  const asked = projection.attention();
  assert.equal(asked.length, 1);
  const one = asked[0];
  assert.ok(one !== undefined && one.kind === "credential");
  assert.equal(one.phase, "asked");
  assert.equal(one.reason, undefined);
  assert.equal(one.url, "https://jira.example");
  assert.deepEqual(one.fields, fields);
  assert.equal(one.node, "root");
  assert.deepEqual(one.path, ["demo"]);
  assert.equal(stateOf(projection, "root"), "blocked");

  projection.apply({
    type: "credential",
    phase: "rejected",
    name: "jira",
    label: "Jira",
    reason: "401 from the server",
    where: "store",
    fields,
  });
  const rejected = projection.attention();
  assert.equal(rejected.length, 1);
  const two = rejected[0];
  assert.ok(two !== undefined && two.kind === "credential");
  assert.equal(two.phase, "rejected");
  assert.equal(two.reason, "401 from the server");
  assert.equal(stateOf(projection, "root"), "blocked");

  projection.apply({ type: "credential", phase: "ready", name: "jira", where: "store" });
  assert.deepEqual(projection.attention(), []);
  assert.equal(stateOf(projection, "root"), "quiet");
});

test("attention lists gates and credentials in ask order", () => {
  const projection = made("demo");
  feed(projection, [ask("g1", "first?")]);
  projection.apply({ type: "credential", phase: "asked", name: "jira", label: "Jira", fields: [] });
  feed(projection, [ask("g2", "second?")]);
  assert.deepEqual(
    projection.attention().map((item) => (item.kind === "gate" ? item.gate : item.name)),
    ["g1", "jira", "g2"],
  );
});

test("waits pair by id and list in start order", () => {
  const projection = made("demo");
  feed(projection, [
    start("a", "deploy"),
    waitStart("w1", "poll ci", "a"),
    waitStart("w2", "poll release"),
  ]);
  assert.deepEqual(
    projection.waiting().map((item) => [item.id, item.label, item.node]),
    [
      ["w1", "poll ci", "a"],
      ["w2", "poll release", "root"],
    ],
  );
  assert.deepEqual(projection.waiting()[0]?.path, ["demo", "deploy"]);
  assert.equal(stateOf(projection, "root"), "idle");

  feed(projection, [waitEnd("w1", "a")]);
  assert.deepEqual(
    projection.waiting().map((item) => item.id),
    ["w2"],
  );
  assert.equal(stateOf(projection, "a"), "quiet");

  feed(projection, [waitEnd("w2")]);
  assert.deepEqual(projection.waiting(), []);
  assert.equal(stateOf(projection, "root"), "quiet");
});

test("a composed call detail shows in the node and in the path", () => {
  const projection = made("demo");
  feed(projection, [
    start("c1", "fix-issue", undefined, "issue: 12"),
    start("c2", "review", "c1", "strict: true"),
    ask("g1", "approve?", "c2"),
  ]);
  assert.equal(projection.node("c1")?.detail, "issue: 12");
  const item = projection.attention()[0];
  assert.ok(item !== undefined);
  assert.deepEqual(item.path, ["demo", "fix-issue (issue: 12)", "review (strict: true)"]);
});

test("an old log without ids or activities projects onto root", () => {
  const projection = made("legacy", "/repo");
  for (const line of [
    JSON.stringify({ type: "run", phase: "started", run: "legacy" }),
    JSON.stringify({ type: "step", phase: "start", id: "s1", label: "plan" }),
    JSON.stringify({ type: "step", phase: "end", id: "s1", label: "plan", ok: true }),
    JSON.stringify({ type: "session", id: "old", name: "planner", use: "claude" }),
    JSON.stringify({ type: "gate", phase: "asked", question: "keep going?" }),
  ]) {
    projection.line(line);
  }
  assert.deepEqual(projection.tree().map((node) => node.id), ["root"]);
  assert.equal(projection.sessionDir("old"), "/repo");
  assert.deepEqual(projection.directories("root"), ["/repo"]);
  const open = projection.attention();
  assert.equal(open.length, 1);
  const item = open[0];
  assert.ok(item !== undefined && item.kind === "gate");
  assert.equal(item.gate, undefined);
  assert.equal(item.question, "keep going?");
  assert.deepEqual(item.path, ["legacy"]);
  assert.equal(stateOf(projection, "root"), "blocked");

  projection.line(JSON.stringify({ type: "gate", phase: "asked", question: "keep going?" }));
  assert.equal(projection.attention().length, 1);

  projection.line(JSON.stringify({ type: "gate", phase: "answered", question: "keep going?", answer: "yes" }));
  assert.deepEqual(projection.attention(), []);
  assert.equal(stateOf(projection, "root"), "quiet");
});

test("an unseen activity attaches to root", () => {
  const projection = made("demo");
  feed(projection, [stepStart("s1", "tsc", "ghost"), ask("g1", "now?", "ghost")]);
  assert.deepEqual(projection.tree().map((node) => node.id), ["root"]);
  assert.equal(projection.attention()[0]?.node, "root");
  assert.equal(stateOf(projection, "root"), "running");
  feed(projection, [stepEnd("s1", "tsc", true, "ghost")]);
  assert.equal(stateOf(projection, "root"), "blocked");
});

test("an unknown type and a garbage line are skipped", () => {
  const projection = made("demo");
  projection.line("not json at all");
  projection.line("[1,2,3]");
  projection.line(JSON.stringify({ type: "sparkle", message: "hi" }));
  projection.apply({ type: "nope" } as unknown as ViewEvent);
  projection.apply({ type: "fact", values: { files: 2 } });
  assert.deepEqual(projection.transcript("root").map((entry) => entry.seq), [0]);
  assert.deepEqual(projection.facts(), { files: 2 });
});

test("a transcript holds a node's subtree and the root holds the whole story", () => {
  const projection = made("demo");
  feed(projection, [
    { type: "run", phase: "started", run: "demo" },
    start("a", "build"),
    start("a1", "compile", "a"),
    { type: "event", level: "info", message: "inner", activity: "a1" },
    { type: "event", level: "info", message: "outer", activity: "a" },
    start("b", "deploy"),
    { type: "event", level: "warn", message: "elsewhere", activity: "b" },
    { type: "artifact", title: "report" },
  ]);
  assert.deepEqual(kinds(projection.transcript("a1")), ["activity", "event"]);
  assert.deepEqual(kinds(projection.transcript("a")), ["activity", "activity", "event", "event"]);
  assert.deepEqual(
    projection.transcript("root").map((entry) => entry.seq),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  assert.deepEqual(projection.transcript("missing"), []);
});

test("session and agent events follow the session's node", () => {
  const projection = made("demo");
  feed(projection, [
    start("a", "build"),
    session("s-1", "coder", "a"),
    session("s-2", "critic"),
    agent("s-1", "writing the patch"),
    agent("s-2", "reading the patch"),
    { type: "message", text: "keep going", session: "s-1" },
  ]);
  assert.equal(projection.sessionName("s-1"), "coder");
  assert.equal(projection.sessionName("s-3"), undefined);
  assert.equal(projection.sessionNode("s-1"), "a");
  assert.equal(projection.sessionNode("s-2"), "root");
  assert.equal(projection.sessionNode("s-3"), "root");
  assert.deepEqual(projection.node("a")?.sessions, ["s-1"]);
  assert.deepEqual(projection.root().sessions, ["s-2"]);
  assert.deepEqual(kinds(projection.transcript("a")), ["activity", "session", "agent", "message"]);
  assert.deepEqual(
    projection.sessionTranscript("s-1").map((entry) => entry.seq),
    [3],
  );
  assert.deepEqual(kinds(projection.sessionTranscript("s-1")), ["agent"]);
  assert.deepEqual(projection.sessionTranscript("s-9"), []);
});

test("a subtree resolves its session directories in first-seen order", () => {
  const projection = made("demo");
  feed(projection, [
    start("a", "build"),
    start("a1", "compile", "a"),
    start("a2", "review", "a"),
    session("s-1", "coder", "a1", "/work/wt-a"),
    session("s-2", "critic", "a2", "/work/wt-b"),
    session("s-3", "second coder", "a1", "/work/wt-c"),
  ]);
  assert.deepEqual(projection.directories("a"), ["/work/wt-a", "/work/wt-b", "/work/wt-c"]);
  assert.deepEqual(projection.directories("a1"), ["/work/wt-a", "/work/wt-c"]);
  assert.deepEqual(projection.directories("root"), ["/work/wt-a", "/work/wt-b", "/work/wt-c"]);
});

test("two sessions on one directory collapse to one entry", () => {
  const projection = made("demo");
  feed(projection, [
    start("a", "build"),
    session("s-1", "coder", "a", "/work/wt-a"),
    session("s-2", "critic", "a", "/work/wt-a"),
  ]);
  assert.deepEqual(projection.directories("a"), ["/work/wt-a"]);
});

test("invariant 19: a subtree with no session, and an unknown node, resolve to the run cwd", () => {
  const projection = made("demo", "/repo");
  feed(projection, [start("a", "build"), start("b", "deploy"), session("s-1", "coder", "a", "/work/wt-a")]);
  assert.deepEqual(projection.directories("b"), ["/repo"]);
  assert.deepEqual(projection.directories("ghost"), ["/work/wt-a"]);

  const empty = made("demo", "/repo");
  assert.deepEqual(empty.directories("root"), ["/repo"]);
});

test("a session resolves its own directory, and an unknown session the run cwd", () => {
  const projection = made("demo", "/repo");
  feed(projection, [session("s-1", "coder", undefined, "/work/wt-a")]);
  assert.equal(projection.sessionDir("s-1"), "/work/wt-a");
  assert.equal(projection.sessionDir("s-9"), "/repo");
});

test("state and watch stay out of every transcript", () => {
  const projection = made("demo");
  feed(projection, [
    { type: "state", state: "running", detail: "tsc" },
    { type: "watch", elapsed: true, diff: "+3 -1" },
    { type: "fact", values: { files: 1 } },
  ]);
  assert.deepEqual(kinds(projection.transcript("root")), ["fact"]);
  assert.deepEqual(
    projection.transcript("root").map((entry) => entry.seq),
    [2],
  );
  assert.deepEqual(projection.runState(), { state: "running", detail: "tsc" });
  assert.deepEqual(projection.watch(), { elapsed: true, diff: "+3 -1" });
});

test("facts keep the last write per key", () => {
  const projection = made("demo");
  feed(projection, [
    { type: "fact", values: { files: 1, branch: "main" } },
    { type: "fact", values: { files: 4, green: true } },
  ]);
  assert.deepEqual(projection.facts(), { files: 4, branch: "main", green: true });
});

test("the run phase drives phase, result, and the root state", () => {
  const projection = made("demo");
  assert.equal(projection.phase(), "live");
  assert.deepEqual(projection.runState(), { state: "running" });
  assert.equal(projection.result(), undefined);

  feed(projection, [{ type: "run", phase: "started", run: "demo" }, { type: "state", state: "blocked", detail: "merge?" }]);
  assert.equal(projection.phase(), "live");
  assert.deepEqual(projection.runState(), { state: "blocked", detail: "merge?" });

  feed(projection, [{ type: "run", phase: "done", run: "demo", result: { merged: true } }]);
  assert.equal(projection.phase(), "done");
  assert.deepEqual(projection.result(), { merged: true });
  assert.deepEqual(projection.runState(), { state: "done" });
  assert.equal(stateOf(projection, "root"), "done");
  assert.equal(projection.root().ended, "ok");
});

test("a stopped run reads done and an error run reads failed", () => {
  const stopped = made("demo");
  feed(stopped, [
    stepStart("s1", "tsc"),
    { type: "run", phase: "stopped", run: "demo", reason: "user stopped it" },
  ]);
  assert.equal(stopped.phase(), "stopped");
  assert.deepEqual(stopped.runState(), { state: "stopped", detail: "user stopped it" });
  assert.equal(stateOf(stopped, "root"), "done");

  const failed = made("demo");
  feed(failed, [{ type: "run", phase: "error", run: "demo", reason: "boom" }]);
  assert.equal(failed.phase(), "error");
  assert.deepEqual(failed.runState(), { state: "error", detail: "boom" });
  assert.equal(stateOf(failed, "root"), "failed");
  assert.equal(failed.root().ended, "failed");
});

const story: ViewEvent[] = [
  { type: "run", phase: "started", run: "demo" },
  start("a", "fix-issue", undefined, "issue: 12"),
  session("s-1", "coder", "a"),
  stepStart("s1", "agent turn", "a"),
  agent("s-1", "reading the repo", "a"),
  { type: "fact", values: { files: 3 } },
  { type: "watch", elapsed: true },
  stepEnd("s1", "agent turn", true, "a"),
  start("b", "review", "a", "strict: true"),
  ask("g1", "merge?", "b"),
  { type: "state", state: "blocked", detail: "merge?" },
  ask("g1", "merge? (yes or no)", "b"),
  answer("g1", "merge? (yes or no)", "yes", "b"),
  waitStart("w1", "poll ci", "b"),
  { type: "event", level: "info", message: "ci queued", activity: "b" },
  waitEnd("w1", "b"),
  finish("b", "ok"),
  { type: "artifact", title: "report", path: "/tmp/report.md" },
  finish("a", "ok"),
  { type: "run", phase: "done", run: "demo", result: { merged: true } },
];

function snapshot(projection: Projection): unknown {
  return {
    tree: projection.tree(),
    attention: projection.attention(),
    waiting: projection.waiting(),
    facts: projection.facts(),
    watch: projection.watch(),
    runState: projection.runState(),
    phase: projection.phase(),
    result: projection.result(),
    root: projection.transcript("root"),
    a: projection.transcript("a"),
    b: projection.transcript("b"),
    session: projection.sessionTranscript("s-1"),
    name: projection.sessionName("s-1"),
    node: projection.sessionNode("s-1"),
  };
}

test("incremental reads give the same result as one batch", () => {
  const batch = made("demo");
  for (const event of story) batch.apply(event);

  const incremental = made("demo");
  for (const event of story) {
    incremental.apply(event);
    snapshot(incremental);
  }
  assert.deepEqual(snapshot(incremental), snapshot(batch));

  const fromLines = made("demo");
  for (const event of story) fromLines.line(JSON.stringify(event));
  assert.deepEqual(snapshot(fromLines), snapshot(batch));
});

test("the finished story reads as one done tree", () => {
  const projection = made("demo");
  for (const event of story) projection.apply(event);
  assert.deepEqual(
    projection.tree().map((node) => [node.id, node.state]),
    [
      ["root", "done"],
      ["a", "done"],
      ["b", "done"],
    ],
  );
  assert.deepEqual(projection.attention(), []);
  assert.deepEqual(projection.waiting(), []);
  assert.deepEqual(projection.facts(), { files: 3 });
  assert.deepEqual(projection.transcript("b").map((entry) => entry.event.type), [
    "activity",
    "gate",
    "gate",
    "gate",
    "wait",
    "event",
    "wait",
    "activity",
  ]);
});
