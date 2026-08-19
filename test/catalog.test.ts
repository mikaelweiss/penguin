import type { AgentAdapter, AgentTurn, Host, ViewEvent } from "@mikaelweiss/penguin-engine";
import { installed, load, loadAdapter, renderEnv } from "@mikaelweiss/penguin-engine/catalog";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type Sandbox, sandbox, waitFor } from "./helpers.ts";

const examples = fileURLToPath(new URL("../packages/engine/examples", import.meta.url));
const workflows = path.join(examples, "workflows");

const codexFile = path.join(examples, "adapters", "codex.ts");

const workflowFiles = [
  "baseline.ts",
  "commit.ts",
  "implement.ts",
  "land.ts",
  "make-workflow.ts",
  "open-pr.ts",
  "plan.ts",
  "pr-queue.ts",
  "review-pr.ts",
  "review.ts",
  "ship-local.ts",
  "ship.ts",
  "triage.ts",
  "work.ts",
];

const fakeVcs = `import fs from "node:fs";
import { adapter } from "penguin";

export default adapter({
  role: "vcs",
  name: "git",
  description: "fake vcs",
  build: (host) => ({
    stageAll: async () => ({ ok: true, reason: "" }),
    commit: async (message) => {
      fs.appendFileSync(host.cwd + "/committed.txt", message + "\\n");
      fs.writeFileSync(host.cwd + "/clean.txt", "clean");
      return { ok: true, reason: "" };
    },
    dirty: async () => ({
      ok: true,
      dirty: !fs.existsSync(host.cwd + "/clean.txt"),
      reason: "",
    }),
    head: async (options) => ({
      ok: true,
      branch: options?.cwd === undefined ? "main" : options.cwd.split("/").pop(),
      sha: "abc1234",
      reason: "",
    }),
    fetch: async () => ({ ok: true, reason: "" }),
    pull: async () => ({ ok: true, reason: "" }),
    push: async (branch) => {
      fs.appendFileSync(host.cwd + "/pushed.txt", branch + "\\n");
      return { ok: true, reason: "" };
    },
    merge: async (branch, options) => {
      fs.appendFileSync(host.cwd + "/merged.txt", branch + " " + String(options?.ffOnly) + "\\n");
      return { ok: true, reason: "" };
    },
    rebase: {
      onto: async (ref) => {
        fs.appendFileSync(host.cwd + "/onto.txt", ref + "\\n");
        return { ok: true, conflicted: false, files: [], reason: "" };
      },
      continue: async () => ({ ok: true, conflicted: false, files: [], reason: "" }),
      abort: async () => ({ ok: true, reason: "" }),
    },
    worktree: {
      add: async (name) => ({ ok: true, path: host.cwd + "/" + name, exists: false, reason: "" }),
      remove: async (target) => {
        fs.appendFileSync(host.cwd + "/removed.txt", target + "\\n");
        return { ok: true, reason: "" };
      },
    },
  }),
});
`;

const conflictVcs = fakeVcs
  .replace(
    `        fs.appendFileSync(host.cwd + "/onto.txt", ref + "\\n");
        return { ok: true, conflicted: false, files: [], reason: "" };`,
    `        fs.appendFileSync(host.cwd + "/onto.txt", ref + "\\n");
        if (fs.existsSync(host.cwd + "/stopped.txt"))
          return { ok: true, conflicted: false, files: [], reason: "" };
        fs.writeFileSync(host.cwd + "/stopped.txt", "stopped");
        return { ok: false, conflicted: true, files: ["src/footer.ts"], reason: "CONFLICT" };`,
  )
  .replace(
    'continue: async () => ({ ok: true, conflicted: false, files: [], reason: "" }),',
    `continue: async () => {
        fs.appendFileSync(host.cwd + "/continued.txt", "continued\\n");
        return { ok: true, conflicted: false, files: [], reason: "" };
      },`,
  );

/** main carries a commit origin never got, so a branch based on origin cannot fast-forward it. */
const aheadVcs = `import fs from "node:fs";
import { adapter } from "penguin";

export default adapter({
  role: "vcs",
  name: "git",
  description: "fake vcs whose main is ahead of origin/main",
  build: (host) => {
    const at = (file, fallback) =>
      fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : fallback;
    const tip = host.cwd + "/tip.txt";
    const base = host.cwd + "/base.txt";
    return {
      stageAll: async () => ({ ok: true, reason: "" }),
      commit: async () => ({ ok: true, reason: "" }),
      dirty: async () => ({ ok: true, dirty: false, reason: "" }),
      head: async () => ({ ok: true, branch: "main", sha: at(tip, "main2"), reason: "" }),
      fetch: async () => ({ ok: true, reason: "" }),
      pull: async () => ({ ok: true, reason: "" }),
      merge: async (branch, options) => {
        fs.appendFileSync(host.cwd + "/merged.txt", branch + "\\n");
        if (branch === "origin/main") return { ok: true, reason: "Already up to date." };
        if (options?.ffOnly === true && at(base, "none") !== at(tip, "main2"))
          return { ok: false, reason: "fatal: Not possible to fast-forward, aborting." };
        fs.writeFileSync(tip, "landed1");
        return { ok: true, reason: "" };
      },
      rebase: {
        onto: async (ref) => {
          fs.appendFileSync(host.cwd + "/onto.txt", ref + "\\n");
          fs.writeFileSync(base, ref === "main" ? at(tip, "main2") : "origin1");
          return { ok: true, conflicted: false, files: [], reason: "" };
        },
        continue: async () => ({ ok: true, conflicted: false, files: [], reason: "" }),
        abort: async () => ({ ok: true, reason: "" }),
      },
      worktree: {
        add: async (name) => ({ ok: true, path: host.cwd + "/" + name, exists: false, reason: "" }),
        remove: async (target) => {
          fs.appendFileSync(host.cwd + "/removed.txt", target + "\\n");
          return { ok: true, reason: "" };
        },
      },
    };
  },
});
`;

const takenVcs = `import fs from "node:fs";
import { adapter } from "penguin";

export default adapter({
  role: "vcs",
  name: "git",
  description: "fake vcs whose worktree path is already taken",
  build: (host) => ({
    stageAll: async () => ({ ok: true, reason: "" }),
    commit: async () => ({ ok: true, reason: "" }),
    dirty: async () => ({ ok: true, dirty: true, reason: "" }),
    head: async () => ({ ok: true, branch: "main", sha: "abc1234", reason: "" }),
    fetch: async () => ({ ok: true, reason: "" }),
    pull: async () => ({ ok: true, reason: "" }),
    merge: async () => ({ ok: true, reason: "" }),
    rebase: {
      onto: async () => ({ ok: true, conflicted: false, files: [], reason: "" }),
      continue: async () => ({ ok: true, conflicted: false, files: [], reason: "" }),
      abort: async () => ({ ok: true, reason: "" }),
    },
    worktree: {
      add: async (name) => {
        const target = host.cwd + "/" + name;
        if (fs.existsSync(host.cwd + "/removed.txt"))
          return { ok: true, path: target, exists: false, reason: "" };
        return { ok: false, path: target, exists: true, reason: target + " already exists" };
      },
      remove: async (target, options) => {
        const how = options?.force === true ? "force " : "";
        fs.appendFileSync(host.cwd + "/removed.txt", how + target + "\\n");
        return { ok: true, reason: "" };
      },
    },
  }),
});
`;

const fakeGithub = `import fs from "node:fs";
import { adapter } from "penguin";

export default adapter({
  role: "github",
  name: "gh",
  description: "fake github",
  build: (host) => ({
    issue: {
      get: async (ref) => ({
        ok: true,
        issue: {
          number: Number(ref),
          title: "the footer scrolls away",
          body: "it should stay put",
          state: "OPEN",
          url: "https://example.test/issues/" + ref,
        },
        reason: "",
      }),
      comments: async () => ({
        ok: true,
        comments: [{ author: "octocat", at: "2026-01-02", body: "it also jumps on resize" }],
        reason: "",
      }),
    },
    pr: {
      get: async (ref) => ({
        ok: true,
        pr: {
          number: Number(ref),
          title: "pin the footer",
          body: "the footer scrolls away",
          state: "OPEN",
          isDraft: false,
          headRefOid: "abc123",
          url: "https://example.test/pr/" + ref,
          isInMergeQueue: false,
        },
        reason: "",
      }),
      comments: async () => ({
        ok: true,
        comments: [{ author: "octocat", at: "2026-01-02", body: "it also jumps on resize" }],
        reason: "",
      }),
      create: async () => ({ ok: true, url: "https://example.test/pr/7", reason: "" }),
      diff: async () => ({ ok: true, diff: "diff --git a/a b/a", reason: "" }),
      comment: async (ref, options) => {
        fs.writeFileSync(host.cwd + "/commented.txt", options.body ?? "");
        return { ok: true, reason: "" };
      },
      approve: async () => {
        fs.writeFileSync(host.cwd + "/approved.txt", "approved");
        return { ok: true, reason: "" };
      },
      changes: () => {
        let sent = false;
        return {
          next: () =>
            new Promise((resolve) => {
              const timer = setInterval(() => {
                if (!sent && fs.existsSync(host.cwd + "/commented.txt")) {
                  sent = true;
                  clearInterval(timer);
                  resolve({ kind: "closed", state: "MERGED" });
                }
              }, 25);
              if (sent) clearInterval(timer);
            }),
        };
      },
    },
  }),
});
`;

const mergeQueueGithub = fakeGithub
  .replace(
    'fs.writeFileSync(host.cwd + "/commented.txt", options.body ?? "");',
    'fs.appendFileSync(host.cwd + "/commented.txt", (options.body ?? "") + "\\n");',
  )
  .replace(
    `      changes: () => {
        let sent = false;
        return {
          next: () =>
            new Promise((resolve) => {
              const timer = setInterval(() => {
                if (!sent && fs.existsSync(host.cwd + "/commented.txt")) {
                  sent = true;
                  clearInterval(timer);
                  resolve({ kind: "closed", state: "MERGED" });
                }
              }, 25);
              if (sent) clearInterval(timer);
            }),
        };
      },`,
    `      changes: () => {
        const steps = [
          { file: "/commented.txt", change: { kind: "queued" } },
          { file: "", change: { kind: "commits" } },
          { file: "/dequeue.txt", change: { kind: "dequeued" } },
          { file: "/close.txt", change: { kind: "closed", state: "MERGED" } },
        ];
        let at = 0;
        return {
          next: () =>
            new Promise((resolve) => {
              const step = steps[at];
              if (step === undefined) return;
              at += 1;
              const tick = () => {
                if (step.file === "" || fs.existsSync(host.cwd + step.file))
                  return resolve(step.change);
                setTimeout(tick, 25);
              };
              tick();
            }),
        };
      },`,
  );

const startQueuedGithub = mergeQueueGithub
  .replace("isInMergeQueue: false,", "isInMergeQueue: true,")
  .replace(
    `          { file: "/commented.txt", change: { kind: "queued" } },
          { file: "", change: { kind: "commits" } },
          { file: "/dequeue.txt", change: { kind: "dequeued" } },`,
    `          { file: "/dequeue.txt", change: { kind: "dequeued" } },`,
  );

const queueGithub = `import fs from "node:fs";
import { adapter } from "penguin";

export default adapter({
  role: "github",
  name: "gh",
  description: "fake github with a queue of review requests",
  build: (host) => ({
    issue: {
      get: async () => ({ ok: false, issue: null, reason: "no issue" }),
      comments: async () => ({ ok: true, comments: [], reason: "" }),
    },
    pr: {
      get: async (ref) => ({
        ok: true,
        pr: {
          number: Number(ref),
          title: "pin the footer",
          body: "the footer scrolls away",
          state: "OPEN",
          isDraft: false,
          headRefOid: "abc123",
          url: "https://example.test/pr/" + ref,
          isInMergeQueue: false,
        },
        reason: "",
      }),
      comments: async () => ({ ok: true, comments: [], reason: "" }),
      create: async () => ({ ok: true, url: "https://example.test/pr/7", reason: "" }),
      diff: async () => ({ ok: true, diff: "", reason: "" }),
      comment: async (ref, options) => {
        fs.appendFileSync(host.cwd + "/commented-" + ref + ".txt", options.body ?? "");
        return { ok: true, reason: "" };
      },
      approve: async (ref) => {
        fs.writeFileSync(host.cwd + "/approved-" + ref + ".txt", "approved");
        return { ok: true, reason: "" };
      },
      changes: (pr) => ({
        next: () =>
          new Promise((resolve) => {
            const tick = () => {
              if (fs.existsSync(host.cwd + "/closed-" + pr + ".txt"))
                return resolve({ kind: "closed", state: "MERGED" });
              setTimeout(tick, 25);
            };
            tick();
          }),
      }),
      requested: async (reviewer) => {
        fs.writeFileSync(host.cwd + "/reviewer.txt", reviewer);
        let at = 0;
        return {
          next: () =>
            new Promise((resolve) => {
              const tick = () => {
                const file = host.cwd + "/requests.txt";
                const lines = fs.existsSync(file)
                  ? fs.readFileSync(file, "utf8").split("\\n").filter((line) => line !== "")
                  : [];
                const line = lines[at];
                if (line === undefined) return setTimeout(tick, 25);
                at += 1;
                resolve({
                  number: Number(line),
                  title: "pin the footer",
                  url: "https://example.test/pr/" + line,
                });
              };
              tick();
            }),
        };
      },
    },
  }),
});
`;

const fakeJira = `import { adapter } from "penguin";

export default adapter({
  role: "jira",
  name: "cloud",
  description: "fake jira",
  build: () => ({
    issue: {
      get: async (key) => ({
        ok: true,
        issue: {
          key,
          summary: "the login times out",
          description: "it hangs at the spinner",
          status: "To Do",
          type: "Bug",
          assignee: "",
          url: "https://example.test/browse/" + key,
        },
        reason: "",
      }),
      comments: async () => ({
        ok: true,
        comments: [{ author: "Ada", at: "2026-01-02", body: "only on the slow network" }],
        reason: "",
      }),
    },
  }),
});
`;

const quietWorkflow = `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ view }) {
    view.event({ message: "nothing to do" });
  },
});
`;

const agentWorkflow = `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ agent }) {
    await agent().run("./skill.md");
  },
});
`;

function freshHome(box: Sandbox): void {
  fs.rmSync(box.home, { recursive: true });
  const first = box.penguin("ps");
  assert.equal(first.code, 0, first.output);
}

function catalogReady(box: Sandbox, result: string): void {
  fs.cpSync(path.join(examples, "skills"), path.join(box.home, "skills"), {
    recursive: true,
  });
  fs.cpSync(path.join(examples, "adapters"), path.join(box.home, "adapters"), {
    recursive: true,
  });
  box.setAgent(result);
  box.setDefaults("agent fake");
}

/** A gh on PATH that fails one way every time, whatever the machine's own gh would say. */
function failingGh(t: TestContext, stderr: string): Record<string, string> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-gh-")));
  fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh\ncat >/dev/null\necho ${JSON.stringify(stderr)} >&2\nexit 1\n`, {
    mode: 0o755,
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { PATH: `${dir}${path.delimiter}${process.env["PATH"] ?? ""}` };
}

function outsideReady(box: Sandbox): void {
  box.writeAdapter("git", fakeVcs);
  box.writeAdapter("gh", fakeGithub);
  box.writeAdapter("jira", fakeJira);
}

async function gateOf(box: Sandbox, run: string): Promise<string> {
  await box.waitForState(run, "blocked");
  return String(box.lastState(run)?.["detail"]);
}

async function answerGate(
  box: Sandbox,
  run: string,
  opens: string,
  text: string,
): Promise<void> {
  await waitFor(() =>
    String(box.lastState(run)?.["detail"] ?? "").startsWith(opens),
  );
  box.send(run, text);
}

type Span = { id: string; parent: string | undefined; label: string };

function activities(box: Sandbox, run: string): Span[] {
  return box
    .events(run)
    .filter(
      (event) => event["type"] === "activity" && event["phase"] === "start",
    )
    .map((event) => ({
      id: String(event["id"]),
      parent: event["parent"] as string | undefined,
      label: String(event["label"]),
    }));
}

function ancestors(spans: Span[], span: Span): string[] {
  const byId = new Map(spans.map((one) => [one.id, one]));
  const labels: string[] = [];
  for (let at = span.parent; at !== undefined; at = byId.get(at)?.parent) {
    const found = byId.get(at);
    if (found === undefined) break;
    labels.push(found.label);
  }
  return labels;
}

function facts(box: Sandbox, run: string): Record<string, unknown>[] {
  return box
    .events(run)
    .filter((event) => event["type"] === "fact")
    .map((event) => event["values"] as Record<string, unknown>);
}

function queuedFacts(box: Sandbox, run: string): number {
  return facts(box, run).filter((values) => values["phase"] === "queued").length;
}

function runNames(box: Sandbox): string[] {
  return fs.readdirSync(box.runs).sort();
}

async function description(file: string): Promise<string> {
  return (await load(path.join(workflows, file))).description;
}

test("every catalog workflow loads with a description and params", async () => {
  const files = fs
    .readdirSync(workflows)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));
  assert.deepEqual(files.sort(), workflowFiles);

  for (const file of files) {
    const definition = await load(path.join(workflows, file));
    assert.ok(
      definition.description.trim() !== "",
      `${file} has no description`,
    );
    assert.ok(
      Object.keys(definition.params.shape).length > 0,
      `${file} takes no params`,
    );
  }
});

test("the shipped defaults pick claude when a second agent adapter is installed", (t) => {
  const box = sandbox(t);
  freshHome(box);
  box.setAgent("none");
  box.write("w.ts", quietWorkflow);

  const started = box.penguin("run", "./w.ts", "--background");

  assert.equal(started.code, 0, started.output);
  assert.equal(started.stdout, "run w-1 started, agent claude\n");
});

test("a default naming an agent that is not installed fails the run and names the file", (t) => {
  const box = sandbox(t);
  freshHome(box);
  fs.rmSync(path.join(box.home, "catalogs"));
  box.setAgent("none");
  box.write("skill.md", "do the thing\n");
  box.write("w.ts", agentWorkflow);

  const failed = box.penguin("run", "./w.ts");

  assert.equal(failed.code, 1, failed.output);
  assert.match(failed.stdout, /no agent adapter named claude\. Installed: fake\./);
  assert.ok(
    failed.stdout.includes(`Edit ${path.join(box.home, "defaults")} to choose one.`),
    failed.output,
  );
  assert.match(String(box.ended("w-1")?.["reason"]), /no agent adapter named claude/);
});

test("the catalog composes the pipelines out of the steps", async () => {
  const importsOf = (file: string): string[] =>
    [
      ...fs
        .readFileSync(path.join(workflows, file), "utf8")
        .matchAll(/from "\.\/([a-z-]+)\.ts"/g),
    ]
      .map((match) => match[1] ?? "")
      .sort();

  assert.deepEqual(importsOf("ship.ts"), ["open-pr", "work"]);
  assert.deepEqual(importsOf("ship-local.ts"), [
    "commit",
    "implement",
    "land",
    "work",
  ]);
  assert.deepEqual(importsOf("work.ts"), ["baseline", "commit", "implement", "plan", "triage"]);
  assert.deepEqual(importsOf("pr-queue.ts"), ["review-pr"]);
  assert.equal(typeof (await load(path.join(workflows, "ship.ts"))), "function");
  assert.equal(
    typeof (await load(path.join(workflows, "ship-local.ts"))),
    "function",
  );
});

test("the catalog ship workflow runs triage to the pull request", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"actionable":true,"reason":"go","tasks":["stop the footer scrolling"],"context":"src/footer.ts holds the footer","green":true,"gates":"bun test: pass","plan":"pin the footer","acceptance":"the footer stays","verdict":"approved","blocking":"","notes":"none","message":"fix: pin the footer","branch":"stop-the-footer-scrolling"}',
  );
  outsideReady(box);

  const started = box.penguin(
    "run",
    path.join(workflows, "ship.ts"),
    "--ticket",
    "ABC-1",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "ship-1", "pin the footer", "approve");
  await answerGate(box, "ship-1", "Task 1 of 1 is in", "done");
  await answerGate(box, "ship-1", "PR is up:", "done");
  const ended = await box.waitForEnd("ship-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { url: "https://example.test/pr/7" });
  assert.deepEqual(runNames(box), ["ship-1"]);

  const spans = activities(box, "ship-1");
  const labels = spans.map((span) => span.label);
  for (const file of [
    "work.ts",
    "triage.ts",
    "baseline.ts",
    "plan.ts",
    "implement.ts",
    "open-pr.ts",
  ]) {
    assert.ok(
      labels.includes(await description(file)),
      `${file} has no activity: ${labels}`,
    );
  }

  const round = spans.find((span) => span.label === "round 1 of 3");
  assert.ok(round !== undefined);
  assert.ok(ancestors(spans, round).includes(await description("implement.ts")));

  const worktree = path.join(box.project, "stop-the-footer-scrolling");
  const dirs = box.sessions().map((line) => line.cwd);
  assert.ok(
    dirs.includes(worktree),
    `no session ran in the worktree: ${dirs.join(", ")}`,
  );
  assert.deepEqual(box.lines("committed.txt"), ["fix: pin the footer"]);
  assert.deepEqual(box.lines("pushed.txt"), ["stop-the-footer-scrolling"]);
});

test("the catalog open-pr workflow holds at the gate when the pull request is already open", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"message":"fix: pin the footer"}');
  outsideReady(box);
  box.writeAdapter(
    "gh",
    fakeGithub.replace(
      'create: async () => ({ ok: true, url: "https://example.test/pr/7", reason: "" })',
      'create: async () => ({ ok: true, url: "https://example.test/pr/7", existed: true, reason: "" })',
    ),
  );

  const started = box.penguin(
    "run",
    path.join(workflows, "open-pr.ts"),
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "open-pr-1", "PR is up:", "done");
  const ended = await box.waitForEnd("open-pr-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { url: "https://example.test/pr/7" });
  assert.deepEqual(box.lines("committed.txt"), ["fix: pin the footer"]);
  assert.deepEqual(box.lines("pushed.txt"), ["main"]);
  assert.equal(box.sessions().length, 1, "one turn, the commit message");
});

test("the catalog plan workflow reads a jira key and its comments, given by position", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"plan":"pin the footer","acceptance":"the footer stays"}',
  );
  outsideReady(box);
  box.setAgent(
    '{"plan":"pin the footer","acceptance":"the footer stays"}',
    "prompts.txt",
  );

  const started = box.penguin(
    "run",
    path.join(workflows, "plan.ts"),
    "https://example.test/browse/ABC-1?atlOrigin=xyz",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "plan-1", "pin the footer", "approve");
  const ended = await box.waitForEnd("plan-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  const [prompt] = box.invocations("prompts.txt");
  assert.match(String(prompt), /ABC-1: the login times out/);
  assert.match(String(prompt), /it hangs at the spinner/);
  assert.match(String(prompt), /# Comments/);
  assert.match(String(prompt), /## Ada on 2026-01-02/);
  assert.match(String(prompt), /only on the slow network/);
});

test("the catalog plan workflow reads a github issue and its comments", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"plan":"pin the footer","acceptance":"the footer stays"}',
  );
  outsideReady(box);
  box.setAgent(
    '{"plan":"pin the footer","acceptance":"the footer stays"}',
    "prompts.txt",
  );

  const started = box.penguin(
    "run",
    path.join(workflows, "plan.ts"),
    "https://github.com/acme/app/issues/12",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "plan-1", "pin the footer", "approve");
  const ended = await box.waitForEnd("plan-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  const [prompt] = box.invocations("prompts.txt");
  assert.match(String(prompt), /the footer scrolls away/);
  assert.match(String(prompt), /## octocat on 2026-01-02/);
  assert.match(String(prompt), /it also jumps on resize/);
});

test("the catalog ship workflow stops at the triage gate", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"actionable":false,"reason":"no repro","tasks":[],"context":""}');
  outsideReady(box);

  const started = box.penguin(
    "run",
    path.join(workflows, "ship.ts"),
    "--ticket",
    "ABC-1",
    "--background",
  );

  assert.equal(started.code, 0, started.output);
  assert.equal(await gateOf(box, "ship-1"), "Not actionable: no repro");
  box.send("ship-1", "ok");
  assert.equal((await box.waitForEnd("ship-1"))["phase"], "done");

  const labels = activities(box, "ship-1").map((span) => span.label);
  assert.deepEqual(labels, [
    await description("work.ts"),
    await description("triage.ts"),
  ]);
});

test("the catalog triage workflow gates a split before returning it", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"actionable":true,"reason":"two seams","tasks":["first slice","second slice"],"context":"two files"}',
  );
  outsideReady(box);

  const started = box.penguin(
    "run",
    path.join(workflows, "triage.ts"),
    "--ticket",
    "ABC-1",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(
    box,
    "triage-1",
    "The ticket splits into 2 tasks",
    "approve",
  );
  const ended = await box.waitForEnd("triage-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], {
    actionable: true,
    reason: "two seams",
    tasks: ["first slice", "second slice"],
    context: "two files",
  });
});

test("the catalog implement workflow runs alone in the invoking repository", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"verdict":"approved","blocking":"","notes":"none"}');

  const started = box.penguin(
    "run",
    path.join(workflows, "implement.ts"),
    "--task",
    "rename the flag",
    "--background",
  );
  assert.equal(started.code, 0, started.output);
  const ended = await box.waitForEnd("implement-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { approved: true, blocking: "", notes: "none" });
  assert.deepEqual(runNames(box), ["implement-1"]);

  const spans = activities(box, "implement-1");
  assert.deepEqual(
    spans.map((span) => span.label),
    ["round 1 of 3"],
  );

  const sessions = box.sessions();
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0]?.session, sessions[1]?.session);
  assert.deepEqual(
    sessions.map((line) => line.cwd),
    [box.project, box.project],
  );
});

test("the catalog implement workflow stops after its round bound", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"verdict":"changes_needed","blocking":"the flag is still there","notes":""}',
  );

  const started = box.penguin(
    "run",
    path.join(workflows, "implement.ts"),
    "--task",
    "rename the flag",
    "--rounds",
    "2",
    "--background",
  );
  assert.equal(started.code, 0, started.output);
  const ended = await box.waitForEnd("implement-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  const result = ended["result"] as { approved: boolean; blocking: string };
  assert.equal(result.approved, false);
  assert.equal(result.blocking, "the flag is still there");
  assert.equal(box.sessions().length, 4, "two rounds, each an implement turn and a review turn");
  const conversations = new Set(box.sessions().map((line) => line.session));
  assert.equal(conversations.size, 2, "one implementer and one reviewer, however many rounds run");
});

test("the catalog ship-local workflow commits, holds, then lands the branch on main", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"actionable":true,"reason":"go","tasks":["stop the footer scrolling"],"context":"src/footer.ts holds the footer","green":true,"gates":"bun test: pass","plan":"pin the footer","acceptance":"the footer stays","verdict":"approved","blocking":"","notes":"none","message":"fix: pin the footer","branch":"stop-the-footer-scrolling"}',
  );
  outsideReady(box);

  const started = box.penguin(
    "run",
    path.join(workflows, "ship-local.ts"),
    "--ticket",
    "the footer scrolls",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "ship-local-1", "pin the footer", "approve");
  await answerGate(box, "ship-local-1", "Task 1 of 1 is in", "done");
  await answerGate(
    box,
    "ship-local-1",
    "stop-the-footer-scrolling is ready",
    "done",
  );
  const ended = await box.waitForEnd("ship-local-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], {
    landed: true,
    sha: "abc1234",
    reason: "",
  });
  assert.deepEqual(box.lines("committed.txt"), ["fix: pin the footer"]);
  assert.deepEqual(box.lines("merged.txt"), [
    "origin/main true",
    "stop-the-footer-scrolling true",
  ]);
  assert.deepEqual(box.lines("onto.txt"), ["main"]);
  assert.deepEqual(box.lines("removed.txt"), [
    path.join(box.project, "stop-the-footer-scrolling"),
  ]);

  const labels = activities(box, "ship-local-1").map((span) => span.label);
  assert.ok(labels.includes(await description("commit.ts")), labels.join(", "));
  assert.ok(labels.includes(await description("land.ts")), labels.join(", "));
});

test("the catalog work workflow holds each task at a gate and takes the change", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"actionable":true,"reason":"go","tasks":["stop the footer scrolling"],"context":"src/footer.ts holds the footer","green":true,"gates":"bun test: pass","plan":"pin the footer","acceptance":"the footer stays","verdict":"approved","blocking":"","notes":"none","message":"fix: pin the footer","branch":"Stop the footer scrolling!"}',
  );
  outsideReady(box);

  const started = box.penguin(
    "run",
    path.join(workflows, "work.ts"),
    "--ticket",
    "the footer scrolls",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "work-1", "pin the footer", "approve");
  await answerGate(box, "work-1", "Task 1 of 1 is in", "make the footer sticky");
  await answerGate(box, "work-1", "Task 1 of 1 is in", "done");
  const ended = await box.waitForEnd("work-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  const built = await description("implement.ts");
  const labels = activities(box, "work-1").map((span) => span.label);
  assert.equal(
    labels.filter((label) => label === built).length,
    2,
    `the change ran no second implement: ${labels.join(", ")}`,
  );

  const dirs = box.sessions().map((line) => line.cwd);
  const worktree = path.join(box.project, "stop-the-footer-scrolling");
  assert.ok(dirs.includes(worktree), `the branch name was not reduced: ${dirs.join(", ")}`);
});

test("the catalog land workflow gives a rebase conflict to an agent, then moves main", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"resolved":true,"notes":"kept both sides"}');
  box.writeAdapter("git", conflictVcs);
  box.setAgent('{"resolved":true,"notes":"kept both sides"}', "prompts.txt");

  const started = box.penguin(
    "run",
    path.join(workflows, "land.ts"),
    "--branch",
    "penguin-ABC-1",
    "--background",
  );
  assert.equal(started.code, 0, started.output);
  const ended = await box.waitForEnd("land-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], {
    landed: true,
    sha: "abc1234",
    reason: "",
  });
  assert.deepEqual(box.lines("continued.txt"), ["continued"]);
  assert.deepEqual(box.lines("merged.txt"), [
    "origin/main true",
    "origin/main true",
    "penguin-ABC-1 true",
  ]);
  assert.deepEqual(box.lines("onto.txt"), ["main", "main"]);
  assert.equal(box.exists("removed.txt"), false);

  const [prompt] = box.invocations("prompts.txt");
  assert.match(String(prompt), /src\/footer\.ts/);
});

test("the catalog land workflow lands on a target that is ahead of origin", async (t) => {
  const box = sandbox(t);
  catalogReady(box, "{}");
  box.writeAdapter("git", aheadVcs);

  const started = box.penguin(
    "run",
    path.join(workflows, "land.ts"),
    "--branch",
    "penguin-ABC-1",
    "--dir",
    path.join(box.project, "tree"),
    "--background",
  );
  assert.equal(started.code, 0, started.output);
  const ended = await box.waitForEnd("land-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { landed: true, sha: "landed1", reason: "" });
  assert.deepEqual(box.lines("onto.txt"), ["main"]);
  assert.deepEqual(box.lines("merged.txt"), ["origin/main", "penguin-ABC-1"]);
  assert.deepEqual(box.lines("removed.txt"), [path.join(box.project, "tree")]);
});

test("the catalog land workflow gates when the checkout is on another branch", async (t) => {
  const box = sandbox(t);
  catalogReady(box, "{}");
  box.writeAdapter("git", fakeVcs.replace('? "main" :', '? "side" :'));

  const started = box.penguin(
    "run",
    path.join(workflows, "land.ts"),
    "--branch",
    "penguin-ABC-1",
    "--background",
  );
  assert.equal(started.code, 0, started.output);
  await box.waitForState("land-1", "blocked");
  box.send("land-1", "ok");
  const ended = await box.waitForEnd("land-1");

  assert.deepEqual(ended["result"], {
    landed: false,
    sha: "",
    reason: "the checkout is on side",
  });
  assert.equal(box.exists("merged.txt"), false);
  assert.equal(box.exists("onto.txt"), false);
});

test("the catalog commit workflow writes nothing when the tree is clean", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"message":"fix: pin the footer"}');
  box.writeAdapter("git", fakeVcs);
  box.write("clean.txt", "clean");

  const started = box.penguin(
    "run",
    path.join(workflows, "commit.ts"),
    "--background",
  );
  assert.equal(started.code, 0, started.output);
  const ended = await box.waitForEnd("commit-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], {
    committed: false,
    message: "",
    reason: "",
  });
  assert.equal(box.exists("committed.txt"), false);
  assert.equal(box.sessions().length, 0);
});

test("the catalog review-pr workflow approves a clean PR and follows it to the close", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"eyeball":false,"reason":"the change spans the parser","blockers":[],"nonBlockers":["tiny nit"]}',
  );
  outsideReady(box);

  const started = box.penguin(
    "run",
    path.join(workflows, "review-pr.ts"),
    "--pr",
    "42",
    "--background",
  );
  assert.equal(started.code, 0, started.output);
  const ended = await box.waitForEnd("review-pr-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { rounds: 1, posted: 1 });
  assert.deepEqual(box.lines("commented.txt"), [
    "### Blockers",
    "none",
    "### Non-blockers",
    "- tiny nit",
  ]);
  assert.ok(box.exists("approved.txt"), "the PR was not approved");
});

test("the catalog review-pr workflow waits while the PR sits in the merge queue", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"eyeball":false,"reason":"the change spans the parser","blockers":[],"nonBlockers":["tiny nit"]}',
  );
  outsideReady(box);
  box.writeAdapter("gh", mergeQueueGithub);

  const started = box.penguin(
    "run",
    path.join(workflows, "review-pr.ts"),
    "--pr",
    "42",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  // The second queued fact proves the loop read the commits change and started no round.
  await waitFor(() => queuedFacts(box, "review-pr-1") >= 2);

  assert.equal(box.sessions().length, 2, "a round ran while the PR waited");
  assert.equal(box.lines("commented.txt").length, 4);

  box.write("dequeue.txt", "left");
  await waitFor(() => box.lines("commented.txt").length === 8);

  box.write("close.txt", "merged");
  const ended = await box.waitForEnd("review-pr-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { rounds: 2, posted: 2 });
  assert.ok(box.exists("approved.txt"), "the PR was not approved");

  const messages = box
    .events("review-pr-1")
    .filter((event) => event["type"] === "event")
    .map((event) => String(event["message"]));
  assert.ok(
    messages.includes("PR #42 is queued to merge, the review waits"),
    messages.join("\n"),
  );
  assert.ok(
    messages.includes("PR #42 left the merge queue"),
    messages.join("\n"),
  );
});

test("the catalog review-pr workflow waits when the PR is queued before the run starts", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"eyeball":false,"reason":"the change spans the parser","blockers":[],"nonBlockers":["tiny nit"]}',
  );
  outsideReady(box);
  box.writeAdapter("gh", startQueuedGithub);

  const started = box.penguin(
    "run",
    path.join(workflows, "review-pr.ts"),
    "--pr",
    "42",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await waitFor(() => queuedFacts(box, "review-pr-1") >= 1);

  assert.equal(box.sessions().length, 1, "a round ran on a queued PR");
  assert.equal(box.exists("commented.txt"), false);

  box.write("dequeue.txt", "left");
  await waitFor(() => box.exists("commented.txt"));

  box.write("close.txt", "merged");
  const ended = await box.waitForEnd("review-pr-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { rounds: 1, posted: 1 });
  assert.ok(box.exists("approved.txt"), "the PR was not approved");
});

test("the catalog review-pr workflow gates on blockers and posts without approving", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"eyeball":false,"reason":"the change spans the parser","blockers":["the flag is wrong"],"nonBlockers":[]}',
  );
  outsideReady(box);

  const started = box.penguin(
    "run",
    path.join(workflows, "review-pr.ts"),
    "--pr",
    "42",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "review-pr-1", "### Blockers", "send");
  const ended = await box.waitForEnd("review-pr-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { rounds: 1, posted: 1 });
  assert.deepEqual(box.lines("commented.txt"), [
    "### Blockers",
    "- the flag is wrong",
    "### Non-blockers",
    "none",
  ]);
  assert.ok(
    !box.exists("approved.txt"),
    "the PR was approved despite a blocker",
  );
});

test("the catalog review-pr workflow reviews in the worktree that is already there", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"eyeball":false,"reason":"the change spans the parser","blockers":[],"nonBlockers":[]}',
  );
  outsideReady(box);
  box.writeAdapter("git", takenVcs);

  const started = box.penguin(
    "run",
    path.join(workflows, "review-pr.ts"),
    "--pr",
    "42",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "review-pr-1", "A worktree already sits at", "use");
  const ended = await box.waitForEnd("review-pr-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { rounds: 1, posted: 1 });
  assert.deepEqual(box.lines("removed.txt"), [
    path.join(box.project, "review-pr-42"),
  ]);
});

test("the catalog review-pr workflow replaces the worktree that is already there", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"eyeball":false,"reason":"the change spans the parser","blockers":[],"nonBlockers":[]}',
  );
  outsideReady(box);
  box.writeAdapter("git", takenVcs);

  const started = box.penguin(
    "run",
    path.join(workflows, "review-pr.ts"),
    "--pr",
    "42",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "review-pr-1", "A worktree already sits at", "replace");
  const ended = await box.waitForEnd("review-pr-1");

  const worktree = path.join(box.project, "review-pr-42");
  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { rounds: 1, posted: 1 });
  assert.deepEqual(box.lines("removed.txt"), [`force ${worktree}`, worktree]);
});

test("the catalog review-pr workflow stops when the user exits the worktree gate", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"eyeball":false,"reason":"the change spans the parser","blockers":[],"nonBlockers":[]}',
  );
  outsideReady(box);
  box.writeAdapter("git", takenVcs);

  const started = box.penguin(
    "run",
    path.join(workflows, "review-pr.ts"),
    "--pr",
    "42",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "review-pr-1", "A worktree already sits at", "exit");
  const ended = await box.waitForEnd("review-pr-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { rounds: 0, posted: 0 });
  assert.ok(
    !box.exists("removed.txt"),
    "the worktree was touched after the exit",
  );
});

test("the catalog review-pr workflow gates when the PR does not read", async (t) => {
  const box = sandbox(t);
  catalogReady(box, "none");

  const started = box.penguinWith(
    failingGh(t, "no pull request found for 42"),
    "run",
    path.join(workflows, "review-pr.ts"),
    "--pr",
    "42",
    "--background",
  );

  assert.equal(started.code, 0, started.output);
  const question = await gateOf(box, "review-pr-1");
  assert.ok(question.startsWith("gh pr view 42 failed:"), question);
  box.send("review-pr-1", "ok");
  assert.equal((await box.waitForEnd("review-pr-1"))["phase"], "done");
});

test("the catalog gh adapter holds a signed out gh before the workflow sees it", async (t) => {
  const box = sandbox(t);
  catalogReady(box, "none");

  const started = box.penguinWith(
    failingGh(t, "not logged in to github.com. use 'gh auth login' to authenticate with this host"),
    "run",
    path.join(workflows, "review-pr.ts"),
    "--pr",
    "42",
    "--background",
  );

  assert.equal(started.code, 0, started.output);
  assert.match(await gateOf(box, "review-pr-1"), /gh auth login/);

  box.send("review-pr-1", "skip");
  await answerGate(box, "review-pr-1", "gh pr view 42 failed:", "ok");
  assert.equal((await box.waitForEnd("review-pr-1"))["phase"], "done");
});

test("the catalog review-pr workflow hands a small PR back to the user", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"eyeball":true,"reason":"one line of copy","blockers":[],"nonBlockers":[]}',
  );
  outsideReady(box);

  const started = box.penguin(
    "run",
    path.join(workflows, "review-pr.ts"),
    "--pr",
    "42",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "review-pr-1", "PR #42 is small enough", "mine");
  const ended = await box.waitForEnd("review-pr-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { rounds: 0, posted: 0 });
  assert.equal(box.sessions().length, 1, "the review ran anyway");
  assert.ok(!box.exists("commented.txt"), "the review posted a comment");
  assert.ok(!box.exists("removed.txt"), "a worktree was cut for a PR nobody reviewed");
});

test("the catalog review-pr workflow reviews the small PR the user keeps", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"eyeball":true,"reason":"one line of copy","blockers":[],"nonBlockers":[]}',
  );
  outsideReady(box);

  const started = box.penguin(
    "run",
    path.join(workflows, "review-pr.ts"),
    "--pr",
    "42",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "review-pr-1", "PR #42 is small enough", "review");
  const ended = await box.waitForEnd("review-pr-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { rounds: 1, posted: 1 });
  assert.ok(box.exists("approved.txt"), "the PR was not approved");
});

test("the catalog pr-queue workflow reviews every request once, beside the watch", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"eyeball":false,"reason":"the change spans the parser","blockers":[],"nonBlockers":[]}',
  );
  box.writeAdapter("git", fakeVcs);
  box.writeAdapter("gh", queueGithub);
  // 42 twice: the second request lands while the review of the first one is still open.
  box.write("requests.txt", "42\n43\n42\n44\n");

  const started = box.penguin(
    "run",
    path.join(workflows, "pr-queue.ts"),
    "--background",
  );
  assert.equal(started.code, 0, started.output);
  // 44 is handed out after 42 arrives the second time, so its review pins what the queue did with it.
  await waitFor(
    () =>
      box.exists("approved-42.txt") &&
      box.exists("approved-43.txt") &&
      box.exists("approved-44.txt"),
  );

  const label = await description("review-pr.ts");
  const reviews = activities(box, "pr-queue-1").filter(
    (span) => span.label === label,
  );
  assert.equal(box.read("reviewer.txt"), "@me");
  assert.equal(reviews.length, 3, "the PR under review was taken twice");
  assert.equal(box.ended("pr-queue-1"), undefined, "the queue stopped watching");
});

test("the catalog make-workflow workflow designs, writes, and reviews the new workflow", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"path":"workflow-design.md","summary":"one summary","file":"new-thing.ts","name":"new-thing","verdict":"approved","findings":"none"}',
  );

  const started = box.penguin(
    "run",
    path.join(workflows, "make-workflow.ts"),
    "--idea",
    "a triage bot",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "make-workflow-1", "Approve the design?", "approve");
  const ended = await box.waitForEnd("make-workflow-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], {
    file: "new-thing.ts",
    run: "pn run new-thing",
  });

  const labels = activities(box, "make-workflow-1").map((span) => span.label);
  assert.deepEqual(labels, ["round 1 of 3"]);

  const sessions = box.sessions();
  assert.equal(sessions.length, 3);
  assert.equal(sessions[0]?.session, sessions[1]?.session);
  assert.notEqual(sessions[1]?.session, sessions[2]?.session);
});

test("the catalog make-workflow workflow stops after its round bound", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"path":"workflow-design.md","summary":"one summary","file":"new-thing.ts","name":"new-thing","verdict":"changes_needed","findings":"the loop has no bound"}',
  );

  const started = box.penguin(
    "run",
    path.join(workflows, "make-workflow.ts"),
    "--idea",
    "a triage bot",
    "--rounds",
    "2",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "make-workflow-1", "Approve the design?", "approve");
  await answerGate(box, "make-workflow-1", "2 rounds and still findings", "ok");
  const ended = await box.waitForEnd("make-workflow-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.equal(box.sessions().length, 5);
});

function skillsNamedBy(file: string): string[] {
  const source = fs.readFileSync(path.join(workflows, file), "utf8");
  return [...source.matchAll(/\.run\("([^"]+)"/g)]
    .map((match) => match[1] ?? "")
    .sort();
}

test("every skill the catalog ships is named by a catalog workflow", () => {
  const named = new Set(workflowFiles.flatMap((file) => skillsNamedBy(file)));
  assert.deepEqual(
    [...named].sort(),
    fs.readdirSync(path.join(examples, "skills")).sort(),
  );

  for (const skill of named) {
    assert.ok(
      fs.existsSync(path.join(examples, "skills", skill, "SKILL.md")),
      `${skill} is missing`,
    );
  }
});

test("every catalog skill follows the SKILL.md format", () => {
  const dir = path.join(examples, "skills");
  const names = fs.readdirSync(dir);
  assert.ok(names.length > 0);

  for (const name of names) {
    assert.match(
      name,
      /^penguin-[a-z0-9]+(-[a-z0-9]+)*$/,
      `${name} is not a penguin- prefixed skill name`,
    );
    assert.ok(name.length <= 64, `${name} is longer than 64 characters`);

    const text = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(front !== null, `${name} has no frontmatter`);

    const fields = new Map(
      (front[1] ?? "")
        .split("\n")
        .map((line) => line.split(/:(.*)/s))
        .map(([key, value]) => [key ?? "", (value ?? "").trim()]),
    );
    assert.deepEqual(
      [...fields.keys()].sort(),
      ["description", "name"],
      `${name} has extra keys`,
    );
    assert.equal(
      fields.get("name"),
      name,
      `the name of ${name} is not the directory name`,
    );
    const description = fields.get("description") ?? "";
    assert.ok(description.length > 0 && description.length <= 1024);
    assert.match(
      description,
      /Use (when|after|before)/,
      `${name} says nothing about when to use it`,
    );
  }
});

type Recorded = { argv: string[]; stdin: string | undefined };

type Scripted = { lines?: string[]; tail?: string; code?: number; stderr?: string };

function codexHost(script: (argv: string[]) => Scripted): {
  host: Host;
  runs: Recorded[];
  events: ViewEvent[];
} {
  const runs: Recorded[] = [];
  const events: ViewEvent[] = [];
  const host: Host = {
    cwd: process.cwd(),
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: async (argv, options) => {
      runs.push({ argv, stdin: options?.stdin });
      const scripted = script(argv);
      for (const line of scripted.lines ?? []) options?.onOutput?.(`${line}\n`, "stdout");
      if (scripted.tail !== undefined) options?.onOutput?.(scripted.tail, "stdout");
      if (scripted.stderr !== undefined) options?.onOutput?.(scripted.stderr, "stderr");
      return scripted.code ?? 0;
    },
    wait: <T>(_label: string, body: () => Promise<T>) => body(),
    emit: (event) => {
      events.push(event);
    },
    gate: (async () => "") as Host["gate"],
    credential: (async () => ({})) as Host["credential"],
  };
  return { host, runs, events };
}

function codexTurn(over: Partial<AgentTurn> = {}): AgentTurn {
  return { session: "s-1", first: true, cwd: process.cwd(), prompt: "do it", options: {}, ...over };
}

function jsonl(...lines: unknown[]): string[] {
  return lines.map((line) => JSON.stringify(line));
}

const envelopeSchema = {
  type: "object",
  properties: {
    result: {
      type: "object",
      properties: { plan: { type: "string" } },
      required: ["plan"],
      additionalProperties: false,
    },
    blocked: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

test("the codex adapter opens a thread, resumes it, and keeps one thread per session", async () => {
  const definition = await loadAdapter(codexFile);
  const { host, runs } = codexHost(() => ({
    lines: jsonl({ type: "thread.started", thread_id: "t-9" }, { type: "turn.completed" }),
  }));
  const api = definition.build(host) as AgentAdapter;

  await api.turn(codexTurn({ prompt: "first" }));
  await api.turn(codexTurn({ first: false, prompt: "second" }));
  await api.turn(codexTurn({ session: "s-2", prompt: "other" }));

  assert.deepEqual(runs[0]?.argv.slice(0, 2), ["codex", "exec"]);
  assert.equal(runs[0]?.argv.includes("resume"), false, "the first turn opens a conversation");
  assert.equal(runs[0]?.argv.at(-1), "-", "codex reads the prompt from stdin");
  assert.equal(runs[0]?.stdin, "first");
  assert.ok(runs[0]?.argv.includes("--json"));
  assert.ok(runs[0]?.argv.includes("--skip-git-repo-check"));
  assert.deepEqual(runs[1]?.argv.slice(0, 4), ["codex", "exec", "resume", "t-9"]);
  assert.equal(runs[1]?.stdin, "second");
  assert.equal(runs[2]?.argv.includes("resume"), false, "another session opens its own thread");
});

test("the codex session options become -c overrides", async () => {
  const definition = await loadAdapter(codexFile);
  const { host, runs } = codexHost(() => ({ lines: jsonl({ type: "turn.completed" }) }));
  const api = definition.build(host) as AgentAdapter;

  await api.turn(codexTurn());
  await api.turn(codexTurn({ session: "s-2", options: { model: "o3", sandbox: "read-only" } }));

  assert.ok(runs[0]?.argv.join(" ").includes('sandbox_mode="workspace-write"'), "a turn edits its worktree");
  assert.equal(runs[0]?.argv.join(" ").includes("model="), false);
  assert.ok(runs[1]?.argv.join(" ").includes('model="o3"'));
  assert.ok(runs[1]?.argv.join(" ").includes('sandbox_mode="read-only"'));
});

test("the codex stream becomes text, thinking, and one event per tool call", async () => {
  const definition = await loadAdapter(codexFile);
  const { host, events } = codexHost(() => ({
    lines: [
      ...jsonl(
        { type: "thread.started", thread_id: "t-1" },
        { type: "item.completed", item: { id: "i1", type: "reasoning", text: "read the spec" } },
        { type: "item.started", item: { id: "i2", type: "command_execution", command: "bun  test\n test/" } },
        { type: "item.completed", item: { id: "i2", type: "command_execution", command: "bun test test/" } },
        {
          type: "item.completed",
          item: { id: "i3", type: "file_change", changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
        },
        {
          type: "item.completed",
          item: { id: "i4", type: "mcp_tool_call", server: "jira", tool: "search", arguments: { jql: "project = ABC" } },
        },
        { type: "item.completed", item: { id: "i5", type: "web_search", query: "codex exec json" } },
        { type: "item.completed", item: { id: "i6", type: "todo_list", items: [] } },
        {
          type: "item.started",
          item: {
            id: "i7",
            type: "collab_tool_call",
            tool: "spawn_agent",
            prompt: "review the diff",
            receiver_thread_ids: ["t-2"],
          },
        },
        { type: "item.completed", item: { id: "i8", type: "error", message: "the patch did not apply" } },
      ),
      "{ not json at all",
    ],
    tail: JSON.stringify({ type: "item.completed", item: { id: "i9", type: "agent_message", text: "all done" } }),
  }));
  const api = definition.build(host) as AgentAdapter;

  const outcome = await api.turn(codexTurn());

  assert.deepEqual(outcome, { ok: true, value: null });
  assert.deepEqual(
    events.flatMap((event) => (event.type === "agent" ? [[event.kind, event.text, event.detail]] : [])),
    [
      ["thinking", "read the spec", undefined],
      ["tool", "shell", "bun test test/"],
      ["tool", "edit", "src/a.ts, src/b.ts"],
      ["tool", "jira.search", '{"jql":"project = ABC"}'],
      ["tool", "search", "codex exec json"],
      ["tool", "collab.spawn_agent", "review the diff"],
      ["text", "the patch did not apply", undefined],
      ["text", "all done", undefined],
    ],
  );
});

test("the codex adapter writes a strict schema and strips the nulls the schema added", async () => {
  const definition = await loadAdapter(codexFile);
  let written: Record<string, unknown> | undefined;
  let schemaFile = "";
  let calls = 0;
  const { host } = codexHost((argv) => {
    schemaFile = argv[argv.indexOf("--output-schema") + 1] ?? "";
    written = JSON.parse(fs.readFileSync(schemaFile, "utf8")) as Record<string, unknown>;
    calls += 1;
    const value = JSON.stringify({ result: { plan: "ship it" }, blocked: null });
    return {
      lines: jsonl(
        { type: "thread.started", thread_id: "t-2" },
        {
          type: "item.completed",
          item: { id: `i${calls}`, type: "agent_message", text: calls === 1 ? value : `\`\`\`json\n${value}\n\`\`\`` },
        },
      ),
    };
  });
  const api = definition.build(host) as AgentAdapter;

  const first = await api.turn(codexTurn({ schema: envelopeSchema }));
  const fenced = await api.turn(codexTurn({ first: false, schema: envelopeSchema }));

  const properties = written?.["properties"] as Record<string, Record<string, unknown>>;
  assert.deepEqual(written?.["required"], ["result", "blocked"], "every property is required");
  assert.deepEqual(properties["result"]?.["type"], ["object", "null"], "an optional property is nullable");
  assert.deepEqual(properties["result"]?.["required"], ["plan"]);
  assert.equal(properties["result"]?.["additionalProperties"], false);
  assert.deepEqual(first, { ok: true, value: { result: { plan: "ship it" } } }, "the added null is gone");
  assert.deepEqual(fenced, { ok: true, value: { result: { plan: "ship it" } } }, "a fenced block still parses");
  assert.equal(fs.existsSync(path.dirname(schemaFile)), false, "the turn removes its temp directory");
});

test("the codex strict rewrite reaches enums, literals, and tuple members", async () => {
  const definition = await loadAdapter(codexFile);
  const schema = z.toJSONSchema(
    z.object({
      tag: z.enum(["a", "b"]).optional(),
      mode: z.literal("fast").optional(),
      pair: z.tuple([z.object({ a: z.string(), b: z.string().optional() }), z.number()]),
    }),
  ) as unknown as Record<string, unknown>;
  let written: Record<string, unknown> = {};
  const { host } = codexHost((argv) => {
    written = JSON.parse(fs.readFileSync(argv[argv.indexOf("--output-schema") + 1] ?? "", "utf8")) as Record<
      string,
      unknown
    >;
    return {
      lines: jsonl({
        type: "item.completed",
        item: {
          id: "i1",
          type: "agent_message",
          text: JSON.stringify({ tag: null, mode: null, pair: [{ a: "one", b: null }, 2] }),
        },
      }),
    };
  });
  const api = definition.build(host) as AgentAdapter;

  const outcome = await api.turn(codexTurn({ schema }));

  const properties = written["properties"] as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties["tag"]?.["enum"], ["a", "b", null], "an optional enum takes null");
  assert.deepEqual(properties["mode"]?.["enum"], ["fast", null], "an optional literal takes null");
  assert.equal(properties["mode"]?.["const"], undefined, "the const gives way to the enum");
  const member = (properties["pair"]?.["prefixItems"] as Record<string, unknown>[])[0];
  assert.deepEqual(member?.["required"], ["a", "b"], "a tuple member is strict too");
  const inner = member?.["properties"] as Record<string, Record<string, unknown>>;
  assert.deepEqual(inner["b"]?.["type"], ["string", "null"]);
  assert.deepEqual(outcome, { ok: true, value: { pair: [{ a: "one" }, 2] } }, "every added null is gone");
});

test("a codex failure comes back as an error the engine can retry", async () => {
  const definition = await loadAdapter(codexFile);
  const crashed = codexHost(() => ({ code: 2, stderr: "warming up\nstream error: retry limit\n" }));
  const refused = codexHost(() => ({ lines: jsonl({ type: "turn.failed", error: { message: "the model refused" } }) }));
  const broke = codexHost(() => ({ lines: jsonl({ type: "error", message: "no credentials" }) }));
  const silent = codexHost(() => ({ lines: jsonl({ type: "thread.started", thread_id: "t-3" }) }));

  const exited = await (definition.build(crashed.host) as AgentAdapter).turn(codexTurn());
  const failed = await (definition.build(refused.host) as AgentAdapter).turn(codexTurn());
  const errored = await (definition.build(broke.host) as AgentAdapter).turn(codexTurn());
  const empty = await (definition.build(silent.host) as AgentAdapter).turn(codexTurn({ schema: envelopeSchema }));

  assert.deepEqual(exited, { ok: false, error: "codex exited with code 2: stream error: retry limit" });
  assert.deepEqual(failed, { ok: false, error: "the model refused" });
  assert.deepEqual(errored, { ok: false, error: "no credentials" });
  assert.deepEqual(empty, { ok: false, error: "codex returned no structured output" });
});

test("a failed codex turn keeps the thread id, so the next turn resumes", async () => {
  const definition = await loadAdapter(codexFile);
  let calls = 0;
  const { host, runs } = codexHost(() => {
    calls += 1;
    if (calls === 1) {
      return {
        lines: jsonl(
          { type: "thread.started", thread_id: "t-7" },
          { type: "turn.failed", error: { message: "the sandbox denied the write" } },
        ),
      };
    }
    return { lines: jsonl({ type: "thread.started", thread_id: "t-7" }) };
  });
  const api = definition.build(host) as AgentAdapter;

  const failed = await api.turn(codexTurn());
  await api.turn(codexTurn({ first: false }));

  assert.deepEqual(failed, { ok: false, error: "the sandbox denied the write" });
  assert.deepEqual(runs[1]?.argv.slice(0, 4), ["codex", "exec", "resume", "t-7"]);
});

test("the catalog adapters and tsconfig are ready to copy", () => {
  for (const name of ["claude", "codex", "cursor", "git", "gh", "jira", "opencode", "pi"]) {
    assert.ok(
      fs.existsSync(path.join(examples, "adapters", `${name}.ts`)),
      name,
    );
  }

  const text = fs.readFileSync(path.join(examples, "tsconfig.json"), "utf8");
  const config = JSON.parse(text.replaceAll(/^\s*\/\/.*$/gm, "")) as {
    compilerOptions: { paths: Record<string, string[]> };
    include: string[];
  };
  assert.ok(config.compilerOptions.paths["penguin"]?.[0]?.includes("penguin"));
  assert.ok(config.compilerOptions.paths["zod"]?.[0]?.includes("zod"));
  assert.ok(config.include.includes("adapters/*.ts"));
});

test("the checked-in penguin-env.d.ts is what penguin writes for the catalog", async () => {
  const prior = process.env["PENGUIN_HOME"];
  process.env["PENGUIN_HOME"] = examples;
  try {
    const list = await installed(examples);
    assert.equal(
      renderEnv(examples, list),
      fs.readFileSync(path.join(examples, "penguin-env.d.ts"), "utf8"),
    );
  } finally {
    if (prior === undefined) delete process.env["PENGUIN_HOME"];
    else process.env["PENGUIN_HOME"] = prior;
  }
});

test("a workflow loads inside a repo whose package.json has no type field", (t) => {
  const box = sandbox(t);
  box.withShell();
  fs.writeFileSync(path.join(box.project, "package.json"), '{"name":"repo"}\n');
  box.write(
    "w.ts",
    `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({ tag: z.string() }),
  async run({ params, shell }) {
    await shell.run(\`sh -c 'echo \${params.tag} >> out.txt'\`);
  },
});
`,
  );

  const done = box.penguin("run", "./w.ts", "--tag", "loaded");

  assert.equal(done.code, 0, done.output);
  assert.deepEqual(box.lines("out.txt"), ["loaded"]);
});
