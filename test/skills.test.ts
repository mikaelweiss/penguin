import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sandbox } from "./helpers.ts";

const agentWorkflow = `import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  params: z.object({ skill: z.string() }),
  async run({ params, step }) {
    await step.agent(params.skill);
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
  box.setAgent(box.agentCommand("none", "prompts.txt"));

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
  box.setAgent(box.agentCommand("none", "prompts.txt"));

  const synced = box.wa("sync-skills", "--global");

  assert.match(synced.stdout, /1 skill is in both: review/);
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
  box.setAgent(box.agentCommand("none", "prompts.txt"));

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
  box.setAgent(box.agentCommand("none", "prompts.txt"));

  assert.equal(box.wa("run", "./w.ts", "--skill", "review").code, 0);

  assert.match(box.invocations("prompts.txt")[0] ?? "", /the wa review/);
});

test("a named skill can be one markdown file", (t) => {
  const box = sandbox(t);
  box.write("w.ts", agentWorkflow);
  fs.mkdirSync(path.join(box.home, "skills"), { recursive: true });
  fs.writeFileSync(path.join(box.home, "skills", "wa-plan.md"), "plan the change\n");
  box.setAgent(box.agentCommand("none", "prompts.txt"));

  const done = box.wa("run", "./w.ts", "--skill", "wa-plan");

  assert.equal(done.code, 0, done.output);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /plan the change/);
});

test("a skill path still resolves against the workflow file", (t) => {
  const box = sandbox(t);
  box.write("w.ts", agentWorkflow);
  box.write("skills/local.md", "the local craft\n");
  box.setAgent(box.agentCommand("none", "prompts.txt"));

  const done = box.wa("run", "./w.ts", "--skill", "./skills/local.md");

  assert.equal(done.code, 0, done.output);
  assert.match(box.invocations("prompts.txt")[0] ?? "", /the local craft/);
});

test("a skill nobody holds parks the run with the places wa looked", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "review it\n");
  box.wa("sync-skills", "--global");
  box.write("w.ts", agentWorkflow);
  box.setAgent(box.agentCommand("none"));

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

test("list skills shows every skill wa can reach, and where it comes from", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "claude review\n");
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "migrate", "migrate it\n");
  box.wa("sync-skills", "--global");
  box.writeSkill(path.join(box.home, "skills"), "wa-triage", "triage it\n");
  box.writeSkill(path.join(box.project, ".wa", "skills"), "house-style", "our style\n");

  const listed = box.wa("list", "skills");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^SKILL\s+SCOPE\s+SOURCE\s+FILE$/m);
  assert.match(listed.stdout, /^house-style\s+local\s+wa\s+/m);
  assert.match(listed.stdout, /^wa-triage\s+global\s+wa\s+/m);
  assert.match(listed.stdout, /^review\s+global\s+claude\s+~\/\.claude\/skills\/review$/m);
  assert.match(listed.stdout, /^migrate\s+global\s+agents\s+~\/\.agents\/skills\/migrate$/m);
});

test("list skills shows the winner of a shared name once", (t) => {
  const box = sandbox(t);
  box.writeSkill(path.join(box.userHome, ".claude", "skills"), "review", "claude review\n");
  box.writeSkill(path.join(box.userHome, ".agents", "skills"), "review", "agents review\n");
  box.wa("sync-skills", "--global");

  const listed = box.wa("list", "skills");

  const rows = listed.stdout.split("\n").filter((line) => line.startsWith("review"));
  assert.equal(rows.length, 1, listed.stdout);
  assert.match(rows[0] ?? "", /^review\s+global\s+claude/);
});

test("list with no target shows the workflows and the skills", (t) => {
  const box = sandbox(t);
  box.write(".wa/ticket.ts", "export default 1;\n");
  box.writeSkill(path.join(box.home, "skills"), "wa-triage", "triage it\n");

  const listed = box.wa("list");

  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.stdout, /^WORKFLOW\s+SCOPE\s+FILE$/m);
  assert.match(listed.stdout, /^SKILL\s+SCOPE\s+SOURCE\s+FILE$/m);
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
