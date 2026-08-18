import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sandbox } from "./helpers.ts";

const agentWorkflow = `import { workflow } from "penguin";
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

  const synced = box.penguin("sync-skills", "--global");

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
  box.penguin("sync-skills", "--global");
  box.write("w.ts", agentWorkflow);
  box.setAgent("none", "prompts.txt");

  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "penguin-triage", "triage it\n");
  const done = box.penguin("run", "./w.ts", "--skill", "penguin-triage");

  assert.equal(done.code, 0, done.output);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /triage it/);
});

test("sync-skills --local links the project directories into .penguin", (t) => {
  const box = sandbox(t);
  const claude = path.join(box.project, ".claude", "skills");
  box.writeSkill(claude, "house-style", "our style\n");
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "review it\n");

  const synced = box.penguin("sync-skills", "--local");

  assert.equal(synced.code, 0, synced.output);
  assert.equal(fs.readlinkSync(path.join(box.project, ".penguin", "skills", "claude")), claude);
  assert.equal(fs.existsSync(path.join(box.home, "skills")), false);
});

test("with no terminal both directories are linked, claude first", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "claude review\n");
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "review", "agents review\n");
  box.write("w.ts", agentWorkflow);
  box.setAgent("none", "prompts.txt");

  const synced = box.penguin("sync-skills", "--global");

  assert.match(synced.stdout, /claude -> ~\/\.claude\/skills\s+\(preferred\)/);
  assert.equal(fs.readFileSync(path.join(box.home, "skills", ".order"), "utf8"), "claude\nagents\n");
  assert.equal(box.penguin("run", "./w.ts", "--skill", "review").code, 0);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /claude review/);
});

test("the preferred directory wins a shared skill name", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "claude review\n");
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "review", "agents review\n");
  box.penguin("sync-skills", "--global");
  box.write("w.ts", agentWorkflow);
  box.setAgent("none", "prompts.txt");

  fs.writeFileSync(path.join(box.home, "skills", ".order"), "agents\nclaude\n");
  assert.equal(box.penguin("run", "./w.ts", "--skill", "review").code, 0);

  assert.match(box.invocations("prompts.txt")[0] ?? "", /agents review/);
});

test("a skill in the penguin skills directory itself resolves first", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "claude review\n");
  box.penguin("sync-skills", "--global");
  box.writeSkill(path.join(box.home, "skills"), "review", "the penguin review\n");
  box.write("w.ts", agentWorkflow);
  box.setAgent("none", "prompts.txt");

  assert.equal(box.penguin("run", "./w.ts", "--skill", "review").code, 0);

  assert.match(box.invocations("prompts.txt")[0] ?? "", /the penguin review/);
});

test("a named skill can be one markdown file", (t) => {
  const box = sandbox(t);
  box.write("w.ts", agentWorkflow);
  fs.mkdirSync(path.join(box.home, "skills"), { recursive: true });
  fs.writeFileSync(path.join(box.home, "skills", "penguin-plan.md"), "plan the change\n");
  box.setAgent("none", "prompts.txt");

  const done = box.penguin("run", "./w.ts", "--skill", "penguin-plan");

  assert.equal(done.code, 0, done.output);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /plan the change/);
});

test("a skill path still resolves against the workflow file", (t) => {
  const box = sandbox(t);
  box.write("w.ts", agentWorkflow);
  box.write("skills/local.md", "the local craft\n");
  box.setAgent("none", "prompts.txt");

  const done = box.penguin("run", "./w.ts", "--skill", "./skills/local.md");

  assert.equal(done.code, 0, done.output);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /the local craft/);
});

test("a skill nobody holds ends the run with the places penguin looked", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "review it\n");
  box.penguin("sync-skills", "--global");
  box.write("w.ts", agentWorkflow);
  box.setAgent("none");

  const failed = box.penguin("run", "./w.ts", "--skill", "penguin-triage");

  assert.equal(failed.code, 1);
  assert.match(failed.stdout, /run w-1 failed: no skill penguin-triage/);
  assert.match(failed.stdout, new RegExp(path.join(box.home, "skills", "claude")));
});

test("sync-skills says when there is no skill directory to link", (t) => {
  const box = sandbox(t);

  const synced = box.penguin("sync-skills", "--global");

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
  box.penguin("sync-skills", "--global");
  box.writeSkill(path.join(box.home, "skills"), "penguin-triage", "triage it\n");
  box.writeSkill(path.join(box.project, ".penguin", "skills"), "house-style", "our style\n");

  const listed = box.penguin("list", "skills");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^house-style$/m);
  assert.match(listed.stdout, /^penguin-triage$/m);
  assert.match(listed.stdout, /^review\n {2}Reviews a working tree\.$/m);
  assert.match(listed.stdout, /^migrate$/m);
  assert.doesNotMatch(listed.stdout, /DESCRIPTION/);
});

test("list skills --verbose adds scope, source, and file", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "claude review\n");
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "migrate", "migrate it\n");
  box.penguin("sync-skills", "--global");
  box.writeSkill(path.join(box.home, "skills"), "penguin-triage", "triage it\n");
  box.writeSkill(path.join(box.project, ".penguin", "skills"), "house-style", "our style\n");

  const listed = box.penguin("list", "skills", "--verbose");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^house-style\n {2}project {2}penguin {2}\S/m);
  assert.match(listed.stdout, /^penguin-triage\n {2}home {2}penguin {2}\S/m);
  assert.match(listed.stdout, /^ {2}home {2}claude {2}~\/\.claude\/skills\/review$/m);
  assert.match(listed.stdout, /^ {2}home {2}agents {2}~\/\.agents\/skills\/migrate$/m);
});

test("list skills shows the winner of a shared name once", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "claude review\n");
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "review", "agents review\n");
  box.penguin("sync-skills", "--global");

  const listed = box.penguin("list", "skills");

  const rows = listed.stdout.split("\n").filter((line) => line.startsWith("review"));
  assert.equal(rows.length, 1, listed.stdout);
  assert.equal(rows[0], "review");
});

test("list with no target names the three targets and fails", (t) => {
  const box = sandbox(t);

  const bare = box.penguin("list");

  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /pn list needs a target: pn list workflows, pn list skills, or pn list adapters/);
});

test("list runs points at pn ps", (t) => {
  const box = sandbox(t);

  const wrong = box.penguin("list", "runs");

  assert.equal(wrong.code, 1);
  assert.match(wrong.stderr, /pn ps shows the runs/);
});

test("list with no skill says how to get one", (t) => {
  const box = sandbox(t);

  const empty = box.penguin("list", "skills");

  assert.equal(empty.code, 0);
  assert.match(empty.stdout, /no skill yet/);
});

test("an unknown sync-skills option is refused", (t) => {
  const box = sandbox(t);

  const failed = box.penguin("sync-skills", "--everything");

  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /unknown option --everything/);
});

test("a symlink penguin did not make survives a sync", (t) => {
  const box = sandbox(t);
  const claude = path.join(box.userHome, ".claude", "skills");
  box.writeSkill(claude, "review", "review it\n");
  const stowed = path.join(box.userHome, "dotfiles", "skills");
  box.writeSkill(stowed, "deploy", "deploy it\n");
  const skills = path.join(box.home, "skills");
  fs.mkdirSync(skills, { recursive: true });
  fs.symlinkSync(stowed, path.join(skills, "dotfiles"));

  const synced = box.penguin("sync-skills", "--global");

  assert.equal(synced.code, 0, synced.output);
  assert.equal(fs.readlinkSync(path.join(skills, "dotfiles")), stowed);
  assert.equal(fs.readlinkSync(path.join(skills, "claude")), claude);
});
