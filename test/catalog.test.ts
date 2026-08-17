import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installed, renderEnv } from "../src/adapters.ts";
import { load } from "../src/loader.ts";
import { type Sandbox, sandbox, waitFor } from "./helpers.ts";

const examples = fileURLToPath(new URL("../examples", import.meta.url));

const workflowFiles = [
  "fix.ts",
  "implement.ts",
  "make-workflow.ts",
  "plan.ts",
  "pr.ts",
  "review-pr.ts",
  "review.ts",
  "ticket.ts",
  "triage.ts",
  "verify.ts",
];

const fakeVcs = `import { adapter } from "penguin";

export default adapter({
  role: "vcs",
  name: "git",
  description: "fake vcs",
  build: (host) => ({
    stageAll: async () => ({ ok: true, reason: "" }),
    commit: async () => ({ ok: true, reason: "" }),
    pull: async () => ({ ok: true, reason: "" }),
    worktree: {
      add: async (name) => ({ ok: true, path: host.cwd + "/" + name, exists: false, reason: "" }),
      remove: async () => ({ ok: true, reason: "" }),
    },
  }),
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
    pull: async () => ({ ok: true, reason: "" }),
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

function catalogReady(box: Sandbox, result: string): void {
  fs.cpSync(path.join(examples, "skills"), path.join(box.home, "skills"), { recursive: true });
  fs.cpSync(path.join(examples, "adapters"), path.join(box.home, "adapters"), { recursive: true });
  box.setAgent(result);
  box.setDefaults("agent fake");
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

async function answerGate(box: Sandbox, run: string, opens: string, text: string): Promise<void> {
  await waitFor(() => String(box.lastState(run)?.["detail"] ?? "").startsWith(opens));
  box.send(run, text);
}

type Span = { id: string; parent: string | undefined; label: string };

function activities(box: Sandbox, run: string): Span[] {
  return box
    .events(run)
    .filter((event) => event["type"] === "activity" && event["phase"] === "start")
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

function runNames(box: Sandbox): string[] {
  return fs.readdirSync(path.join(box.home, "runs")).sort();
}

async function description(file: string): Promise<string> {
  return (await load(path.join(examples, file))).description;
}

test("every catalog workflow loads with a description and params", async () => {
  const files = fs
    .readdirSync(examples)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"));
  assert.deepEqual(files.sort(), workflowFiles);

  for (const file of files) {
    const definition = await load(path.join(examples, file));
    assert.ok(definition.description.trim() !== "", `${file} has no description`);
    assert.ok(Object.keys(definition.params.shape).length > 0, `${file} takes no params`);
  }
});

test("the catalog composes the big workflows out of the small ones", async () => {
  const ticket = await load(path.join(examples, "ticket.ts"));
  const source = fs.readFileSync(path.join(examples, "ticket.ts"), "utf8");
  const imports = [...source.matchAll(/from "\.\/([a-z-]+)\.ts"/g)].map((match) => match[1] ?? "");
  assert.deepEqual(imports.sort(), ["implement", "plan", "pr", "triage"]);
  assert.equal(typeof ticket, "function");
});

test("the catalog ticket workflow runs triage to the pull request", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"actionable":true,"reason":"go","tasks":["stop the footer scrolling"],"plan":"pin the footer","acceptance":"the footer stays","verdict":"approved","findings":"none"}',
  );
  outsideReady(box);

  const started = box.penguin("run", path.join(examples, "ticket.ts"), "--ticket", "ABC-1", "--background");
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "ticket-1", "pin the footer", "approve");
  await answerGate(box, "ticket-1", "PR is up:", "done");
  const ended = await box.waitForEnd("ticket-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { url: "https://example.test/pr/7" });
  assert.deepEqual(runNames(box), ["ticket-1"]);

  const spans = activities(box, "ticket-1");
  const labels = spans.map((span) => span.label);
  for (const file of ["triage.ts", "plan.ts", "implement.ts", "review.ts", "pr.ts"]) {
    assert.ok(labels.includes(await description(file)), `${file} has no activity: ${labels}`);
  }

  const reviews = await description("review.ts");
  const reviewed = spans.find((span) => span.label === reviews);
  assert.ok(reviewed !== undefined);
  assert.ok(ancestors(spans, reviewed).includes(await description("implement.ts")));

  const worktree = path.join(box.project, "penguin-ABC-1");
  const dirs = box.sessions().map((line) => line.cwd);
  assert.ok(dirs.includes(worktree), `no session ran in the worktree: ${dirs.join(", ")}`);
});

test("the catalog plan workflow reads a jira key and its comments, given by position", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"plan":"pin the footer","acceptance":"the footer stays"}');
  outsideReady(box);
  box.setAgent('{"plan":"pin the footer","acceptance":"the footer stays"}', "prompts.txt");

  const started = box.penguin(
    "run",
    path.join(examples, "plan.ts"),
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
  catalogReady(box, '{"plan":"pin the footer","acceptance":"the footer stays"}');
  outsideReady(box);
  box.setAgent('{"plan":"pin the footer","acceptance":"the footer stays"}', "prompts.txt");

  const started = box.penguin(
    "run",
    path.join(examples, "plan.ts"),
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

test("the catalog ticket workflow stops at the triage gate", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"actionable":false,"reason":"no repro","tasks":[]}');

  const started = box.penguin("run", path.join(examples, "ticket.ts"), "--ticket", "ABC-1", "--background");

  assert.equal(started.code, 0, started.output);
  assert.equal(await gateOf(box, "ticket-1"), "Not actionable: no repro");
  box.send("ticket-1", "ok");
  assert.equal((await box.waitForEnd("ticket-1"))["phase"], "done");

  const labels = activities(box, "ticket-1").map((span) => span.label);
  assert.deepEqual(labels, [await description("triage.ts")]);
});

test("the catalog triage workflow gates a split before returning it", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"actionable":true,"reason":"two seams","tasks":["first slice","second slice"]}');

  const started = box.penguin("run", path.join(examples, "triage.ts"), "--ticket", "ABC-1", "--background");
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "triage-1", "The ticket splits into 2 tasks", "approve");
  const ended = await box.waitForEnd("triage-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], {
    actionable: true,
    reason: "two seams",
    tasks: ["first slice", "second slice"],
  });
});

test("the catalog implement workflow runs alone in the invoking repository", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"verdict":"approved","findings":"none"}');

  const started = box.penguin(
    "run",
    path.join(examples, "implement.ts"),
    "--task",
    "rename the flag",
    "--background",
  );
  assert.equal(started.code, 0, started.output);
  const ended = await box.waitForEnd("implement-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { approved: true, findings: ["none"] });
  assert.deepEqual(runNames(box), ["implement-1"]);

  const spans = activities(box, "implement-1");
  assert.deepEqual(
    spans.map((span) => span.label),
    ["round 1 of 3", await description("review.ts")],
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
  catalogReady(box, '{"verdict":"changes_needed","findings":"the flag is still there"}');

  const started = box.penguin(
    "run",
    path.join(examples, "implement.ts"),
    "--task",
    "rename the flag",
    "--rounds",
    "2",
    "--background",
  );
  assert.equal(started.code, 0, started.output);
  const ended = await box.waitForEnd("implement-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  const result = ended["result"] as { approved: boolean; findings: string[] };
  assert.equal(result.approved, false);
  assert.equal(result.findings.length, 2);
  assert.equal(box.sessions().length, 4);
});

test("the catalog fix workflow gates when the bug does not reproduce", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"reproduced":false,"notes":"the page loads"}');

  const started = box.penguin("run", path.join(examples, "fix.ts"), "--bug", "BUG-2", "--background");

  assert.equal(started.code, 0, started.output);
  assert.equal(await gateOf(box, "fix-1"), "Not reproduced: the page loads");
  box.send("fix-1", "ok");
  assert.equal((await box.waitForEnd("fix-1"))["phase"], "done");
});

test("the catalog fix workflow verifies the fix and opens the pull request", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"reproduced":true,"notes":"the list is empty","passing":true,"details":"3 tests pass"}',
  );
  outsideReady(box);

  const started = box.penguin("run", path.join(examples, "fix.ts"), "--bug", "BUG-2", "--background");
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "fix-1", "PR is up:", "done");
  const ended = await box.waitForEnd("fix-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { url: "https://example.test/pr/7" });
  assert.deepEqual(runNames(box), ["fix-1"]);

  const labels = activities(box, "fix-1").map((span) => span.label);
  assert.deepEqual(labels, [
    "round 1 of 3",
    await description("verify.ts"),
    await description("pr.ts"),
  ]);
});

test("the catalog review-pr workflow approves a clean PR and follows it to the close", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"blockers":[],"nonBlockers":["tiny nit"]}');
  outsideReady(box);

  const started = box.penguin("run", path.join(examples, "review-pr.ts"), "--pr", "42", "--background");
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

test("the catalog review-pr workflow gates on blockers and posts without approving", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"blockers":["the flag is wrong"],"nonBlockers":[]}');
  outsideReady(box);

  const started = box.penguin("run", path.join(examples, "review-pr.ts"), "--pr", "42", "--background");
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
  assert.ok(!box.exists("approved.txt"), "the PR was approved despite a blocker");
});

test("the catalog review-pr workflow reviews in the worktree that is already there", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"blockers":[],"nonBlockers":[]}');
  outsideReady(box);
  box.writeAdapter("git", takenVcs);

  const started = box.penguin("run", path.join(examples, "review-pr.ts"), "--pr", "42", "--background");
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "review-pr-1", "A worktree already sits at", "use");
  const ended = await box.waitForEnd("review-pr-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { rounds: 1, posted: 1 });
  assert.deepEqual(box.lines("removed.txt"), [path.join(box.project, "review-pr-42")]);
});

test("the catalog review-pr workflow replaces the worktree that is already there", async (t) => {
  const box = sandbox(t);
  catalogReady(box, '{"blockers":[],"nonBlockers":[]}');
  outsideReady(box);
  box.writeAdapter("git", takenVcs);

  const started = box.penguin("run", path.join(examples, "review-pr.ts"), "--pr", "42", "--background");
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
  catalogReady(box, '{"blockers":[],"nonBlockers":[]}');
  outsideReady(box);
  box.writeAdapter("git", takenVcs);

  const started = box.penguin("run", path.join(examples, "review-pr.ts"), "--pr", "42", "--background");
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "review-pr-1", "A worktree already sits at", "exit");
  const ended = await box.waitForEnd("review-pr-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { rounds: 0, posted: 0 });
  assert.ok(!box.exists("removed.txt"), "the worktree was touched after the exit");
});

test("the catalog review-pr workflow gates when the PR does not read", async (t) => {
  const box = sandbox(t);
  catalogReady(box, "none");

  const started = box.penguin("run", path.join(examples, "review-pr.ts"), "--pr", "42", "--background");

  assert.equal(started.code, 0, started.output);
  const question = await gateOf(box, "review-pr-1");
  assert.ok(question.startsWith("gh pr view 42 failed:"), question);
  box.send("review-pr-1", "ok");
  assert.equal((await box.waitForEnd("review-pr-1"))["phase"], "done");
});

test("the catalog make-workflow workflow designs, writes, and reviews the new workflow", async (t) => {
  const box = sandbox(t);
  catalogReady(
    box,
    '{"path":"workflow-design.md","summary":"one summary","file":"new-thing.ts","name":"new-thing","verdict":"approved","findings":"none"}',
  );

  const started = box.penguin(
    "run",
    path.join(examples, "make-workflow.ts"),
    "--idea",
    "a triage bot",
    "--background",
  );
  assert.equal(started.code, 0, started.output);

  await answerGate(box, "make-workflow-1", "Approve the design?", "approve");
  const ended = await box.waitForEnd("make-workflow-1");

  assert.equal(ended["phase"], "done", JSON.stringify(ended));
  assert.deepEqual(ended["result"], { file: "new-thing.ts", run: "pn run new-thing" });

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
    path.join(examples, "make-workflow.ts"),
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
  const source = fs.readFileSync(path.join(examples, file), "utf8");
  return [...source.matchAll(/\.run\("([^"]+)"/g)].map((match) => match[1] ?? "").sort();
}

test("every skill the catalog ships is named by a catalog workflow", () => {
  const named = new Set(workflowFiles.flatMap((file) => skillsNamedBy(file)));
  assert.deepEqual([...named].sort(), fs.readdirSync(path.join(examples, "skills")).sort());

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
    assert.match(name, /^penguin-[a-z0-9]+(-[a-z0-9]+)*$/, `${name} is not a penguin- prefixed skill name`);
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
    assert.deepEqual([...fields.keys()].sort(), ["description", "name"], `${name} has extra keys`);
    assert.equal(fields.get("name"), name, `the name of ${name} is not the directory name`);
    const description = fields.get("description") ?? "";
    assert.ok(description.length > 0 && description.length <= 1024);
    assert.match(description, /Use (when|after|before)/, `${name} says nothing about when to use it`);
  }
});

test("the catalog adapters and tsconfig are ready to copy", () => {
  for (const name of ["claude", "git", "gh", "jira", "terminal"]) {
    assert.ok(fs.existsSync(path.join(examples, "adapters", `${name}.ts`)), name);
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
