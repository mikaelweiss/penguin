import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sandbox } from "./helpers.ts";

const agentWorkflow = `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({ skill: z.string() }),
  async run({ params, agent }) {
    await agent().run(params.skill);
  },
});
`;

test("sync-skills links the whole skill directory, not each skill", (t) => {
  const box = sandbox(t);
  const claude = path.join(box.userHome, ".claude", "skills");
  box.writeSkill(claude, "review", "review it\n");
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "migrate", "migrate it\n");

  const synced = box.wa("sync-skills", "--global");

  assert.equal(synced.code, 0, synced.output);
  const skills = path.join(box.home, "skills");
  assert.equal(fs.readlinkSync(path.join(skills, "claude")), claude);
  assert.equal(
    fs.readlinkSync(path.join(skills, "agents")),
    path.join(box.userHome, ".agents", "skills"),
  );
  assert.match(synced.stdout, /claude -> ~\/\.claude\/skills/);
  assert.match(synced.stdout, /agents -> ~\/\.agents\/skills/);
});

test("a skill added after the sync needs no second sync", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "review it\n");
  box.wa("sync-skills", "--global");
  box.write("w.ts", agentWorkflow);
  box.setAgent("none", "prompts.txt");

  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "wa-triage", "triage it\n");
  const done = box.wa("run", "./w.ts", "--skill", "wa-triage");

  assert.equal(done.code, 0, done.output);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /triage it/);
});

test("sync-skills --local links the project directories into .wa", (t) => {
  const box = sandbox(t);
  const claude = path.join(box.project, ".claude", "skills");
  box.writeSkill(claude, "house-style", "our style\n");
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "review it\n");

  const synced = box.wa("sync-skills", "--local");

  assert.equal(synced.code, 0, synced.output);
  assert.equal(fs.readlinkSync(path.join(box.project, ".wa", "skills", "claude")), claude);
  assert.equal(fs.existsSync(path.join(box.home, "skills")), false);
});

test("with no terminal both directories are linked, claude first", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "claude review\n");
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "review", "agents review\n");
  box.write("w.ts", agentWorkflow);
  box.setAgent("none", "prompts.txt");

  const synced = box.wa("sync-skills", "--global");

  assert.match(synced.stdout, /claude -> ~\/\.claude\/skills\s+\(preferred\)/);
  assert.equal(fs.readFileSync(path.join(box.home, "skills", ".order"), "utf8"), "claude\nagents\n");
  assert.equal(box.wa("run", "./w.ts", "--skill", "review").code, 0);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /claude review/);
});

test("the preferred directory wins a shared skill name", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "claude review\n");
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "review", "agents review\n");
  box.wa("sync-skills", "--global");
  box.write("w.ts", agentWorkflow);
  box.setAgent("none", "prompts.txt");

  fs.writeFileSync(path.join(box.home, "skills", ".order"), "agents\nclaude\n");
  assert.equal(box.wa("run", "./w.ts", "--skill", "review").code, 0);

  assert.match(box.invocations("prompts.txt")[0] ?? "", /agents review/);
});

test("a skill in the wa skills directory itself resolves first", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "claude review\n");
  box.wa("sync-skills", "--global");
  box.writeSkill(path.join(box.home, "skills"), "review", "the wa review\n");
  box.write("w.ts", agentWorkflow);
  box.setAgent("none", "prompts.txt");

  assert.equal(box.wa("run", "./w.ts", "--skill", "review").code, 0);

  assert.match(box.invocations("prompts.txt")[0] ?? "", /the wa review/);
});

test("a named skill can be one markdown file", (t) => {
  const box = sandbox(t);
  box.write("w.ts", agentWorkflow);
  fs.mkdirSync(path.join(box.home, "skills"), { recursive: true });
  fs.writeFileSync(path.join(box.home, "skills", "wa-plan.md"), "plan the change\n");
  box.setAgent("none", "prompts.txt");

  const done = box.wa("run", "./w.ts", "--skill", "wa-plan");

  assert.equal(done.code, 0, done.output);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /plan the change/);
});

test("a skill path still resolves against the workflow file", (t) => {
  const box = sandbox(t);
  box.write("w.ts", agentWorkflow);
  box.write("skills/local.md", "the local craft\n");
  box.setAgent("none", "prompts.txt");

  const done = box.wa("run", "./w.ts", "--skill", "./skills/local.md");

  assert.equal(done.code, 0, done.output);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /the local craft/);
});

test("a skill nobody holds parks the run with the places wa looked", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "review it\n");
  box.wa("sync-skills", "--global");
  box.write("w.ts", agentWorkflow);
  box.setAgent("none");

  const parked = box.wa("run", "./w.ts", "--skill", "wa-triage");

  assert.equal(parked.code, 1);
  assert.match(parked.stdout, /no skill wa-triage/);
  assert.match(parked.stdout, new RegExp(path.join(box.home, "skills", "claude")));
});

test("sync-skills says when there is no skill directory to link", (t) => {
  const box = sandbox(t);

  const synced = box.wa("sync-skills", "--global");

  assert.equal(synced.code, 0);
  assert.match(synced.stdout, /no \.claude\/skills or \.agents\/skills/);
});

test("list skills shows name and description", (t) => {
  const box = sandbox(t);
  box.writeSkill(
    path.join(box.userHome, ".claude", "skills"),
    "review",
    "---\nname: review\ndescription: Reviews a working tree.\n---\nclaude review\n",
  );
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "migrate", "migrate it\n");
  box.wa("sync-skills", "--global");
  box.writeSkill(path.join(box.home, "skills"), "wa-triage", "triage it\n");
  box.writeSkill(path.join(box.project, ".wa", "skills"), "house-style", "our style\n");

  const listed = box.wa("list", "skills");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^house-style$/m);
  assert.match(listed.stdout, /^wa-triage$/m);
  assert.match(listed.stdout, /^review\n {2}Reviews a working tree\.$/m);
  assert.match(listed.stdout, /^migrate$/m);
  assert.doesNotMatch(listed.stdout, /DESCRIPTION/);
});

test("list skills --verbose adds scope, source, and file", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "claude review\n");
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "migrate", "migrate it\n");
  box.wa("sync-skills", "--global");
  box.writeSkill(path.join(box.home, "skills"), "wa-triage", "triage it\n");
  box.writeSkill(path.join(box.project, ".wa", "skills"), "house-style", "our style\n");

  const listed = box.wa("list", "skills", "--verbose");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^house-style\n {2}local {2}wa {2}\S/m);
  assert.match(listed.stdout, /^wa-triage\n {2}global {2}wa {2}\S/m);
  assert.match(listed.stdout, /^ {2}global {2}claude {2}~\/\.claude\/skills\/review$/m);
  assert.match(listed.stdout, /^ {2}global {2}agents {2}~\/\.agents\/skills\/migrate$/m);
});

test("list skills shows the winner of a shared name once", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "claude review\n");
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "review", "agents review\n");
  box.wa("sync-skills", "--global");

  const listed = box.wa("list", "skills");

  const rows = listed.stdout.split("\n").filter((line) => line.startsWith("review"));
  assert.equal(rows.length, 1, listed.stdout);
  assert.equal(rows[0], "review");
});

test("list with no target names the three targets and fails", (t) => {
  const box = sandbox(t);

  const bare = box.wa("list");

  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /wa list needs a target: wa list workflows, wa list skills, or wa list adapters/);
});

test("list runs points at wa ps", (t) => {
  const box = sandbox(t);

  const wrong = box.wa("list", "runs");

  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /wa ps shows the runs/);
});

test("list with no skill says how to get one", (t) => {
  const box = sandbox(t);

  const empty = box.wa("list", "skills");

  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /no skill yet/);
});

test("an unknown sync-skills option is refused", (t) => {
  const box = sandbox(t);

  const failed = box.wa("sync-skills", "--everything");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /unknown option --everything/);
});
