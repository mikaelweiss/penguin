import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResult, Host } from "../src/core/adapter.ts";
import { roots } from "../src/catalog/catalogs.ts";
import { skillLookup } from "../src/catalog/skills.ts";
import { createHost } from "../src/host.ts";
import definition from "../examples/adapters/git.ts";

function hostFor(dir: string): Host {
  return createHost(dir, { id: "test", dir }, skillLookup(roots(dir)));
}

let temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

async function git(host: Host, args: string[]): Promise<string> {
  const done = await host.exec(["git", ...args]);
  if (done.code !== 0) throw new Error(done.stderr);
  return done.stdout.trim();
}

async function repo(): Promise<{ dir: string; host: Host; vcs: ReturnType<typeof definition.build> }> {
  const dir = tempDir("penguin-git-");
  const host = hostFor(dir);
  await git(host, ["init", "-q"]);
  await git(host, ["config", "user.email", "test@test"]);
  await git(host, ["config", "user.name", "test"]);
  return { dir, host, vcs: definition.build(host) };
}

async function commitFile(
  where: { dir: string; host: Host },
  name: string,
  message: string,
): Promise<void> {
  fs.writeFileSync(path.join(where.dir, name), `${name}\n`);
  await git(where.host, ["add", name]);
  await git(where.host, ["commit", "-q", "-m", message]);
}

test("stage, commit, dirty, and head walk the happy path", async () => {
  const { dir, vcs } = await repo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  expect((await vcs.dirty()).dirty).toBe(true);
  expect((await vcs.stage(["a.txt"])).ok).toBe(true);
  const committed = await vcs.commit("test: first");
  expect(committed.ok).toBe(true);
  expect((await vcs.dirty()).dirty).toBe(false);
  const head = await vcs.head();
  expect(head.ok).toBe(true);
  expect(head.detached).toBe(false);
  expect(head.sha).not.toBe("");
});

test("a commit message with quotes survives intact", async () => {
  const { dir, host, vcs } = await repo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  await vcs.stage(["a.txt"]);
  const message = `test: it's "quoted" $(danger)`;
  expect((await vcs.commit(message)).ok).toBe(true);
  expect(await git(host, ["log", "-1", "--format=%s"])).toBe(message);
});

test("pull refuses to touch diverged work; resetHard is the explicit discard", async () => {
  const bare = tempDir("penguin-bare-");
  await git(hostFor(bare), ["init", "-q", "--bare"]);

  const ours = await repo();
  await commitFile(ours, "base.txt", "base");
  await git(ours.host, ["remote", "add", "origin", bare]);
  const branch = (await ours.vcs.head()).branch;
  await git(ours.host, ["push", "-q", "-u", "origin", branch]);

  const theirsDir = tempDir("penguin-theirs-");
  const theirs = { dir: theirsDir, host: hostFor(theirsDir) };
  await git(theirs.host, ["clone", "-q", bare, "."]);
  await git(theirs.host, ["config", "user.email", "test@test"]);
  await git(theirs.host, ["config", "user.name", "test"]);
  await commitFile(theirs, "theirs.txt", "theirs");
  await git(theirs.host, ["push", "-q"]);

  await commitFile(ours, "ours.txt", "ours");
  const before = await git(ours.host, ["rev-parse", "HEAD"]);

  const pulled = await ours.vcs.pull(branch);
  expect(pulled.ok).toBe(false);
  expect(await git(ours.host, ["rev-parse", "HEAD"])).toBe(before);
  expect(fs.existsSync(path.join(ours.dir, "ours.txt"))).toBe(true);

  const reset = await ours.vcs.resetHard("FETCH_HEAD");
  expect(reset.ok).toBe(true);
  expect(fs.existsSync(path.join(ours.dir, "theirs.txt"))).toBe(true);
  expect(fs.existsSync(path.join(ours.dir, "ours.txt"))).toBe(false);
});

test("worktree.add notes the new folder in the run's file", async () => {
  const home = tempDir("penguin-home-");
  process.env["PENGUIN_HOME"] = home;
  try {
    const { dir, host, vcs } = await repo();
    await commitFile({ dir, host }, "base.txt", "base");
    const added = await vcs.worktree.add("feature");
    expect(added.ok).toBe(true);
    expect(added.path.startsWith(path.join(home, "worktrees"))).toBe(true);
    const written = fs.readFileSync(path.join(dir, "run.jsonl"), "utf8");
    const note = JSON.parse(written.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    expect(note["dir"]).toBe(added.path);
  } finally {
    delete process.env["PENGUIN_HOME"];
  }
});

test("pull fast-forwards when histories have not diverged", async () => {
  const bare = tempDir("penguin-bare-");
  await git(hostFor(bare), ["init", "-q", "--bare"]);

  const ours = await repo();
  await commitFile(ours, "base.txt", "base");
  await git(ours.host, ["remote", "add", "origin", bare]);
  const branch = (await ours.vcs.head()).branch;
  await git(ours.host, ["push", "-q", "-u", "origin", branch]);

  const theirsDir = tempDir("penguin-theirs-");
  const theirs = { dir: theirsDir, host: hostFor(theirsDir) };
  await git(theirs.host, ["clone", "-q", bare, "."]);
  await git(theirs.host, ["config", "user.email", "test@test"]);
  await git(theirs.host, ["config", "user.name", "test"]);
  await commitFile(theirs, "theirs.txt", "theirs");
  await git(theirs.host, ["push", "-q"]);

  const pulled = await ours.vcs.pull(branch);
  expect(pulled.ok).toBe(true);
  expect(fs.existsSync(path.join(ours.dir, "theirs.txt"))).toBe(true);
});

test("fetch moves the branch's remote-tracking ref", async () => {
  const bare = tempDir("penguin-bare-");
  await git(hostFor(bare), ["init", "-q", "--bare"]);

  const ours = await repo();
  await commitFile(ours, "base.txt", "base");
  await git(ours.host, ["remote", "add", "origin", bare]);
  const branch = (await ours.vcs.head()).branch;
  await git(ours.host, ["push", "-q", "-u", "origin", branch]);

  const theirsDir = tempDir("penguin-theirs-");
  const theirs = { dir: theirsDir, host: hostFor(theirsDir) };
  await git(theirs.host, ["clone", "-q", bare, "."]);
  await git(theirs.host, ["config", "user.email", "test@test"]);
  await git(theirs.host, ["config", "user.name", "test"]);
  await commitFile(theirs, "theirs.txt", "theirs");
  await git(theirs.host, ["push", "-q"]);
  const sent = await git(theirs.host, ["rev-parse", "HEAD"]);

  const fetched = await ours.vcs.fetch(branch);
  expect(fetched.ok).toBe(true);
  expect(await git(ours.host, ["rev-parse", `origin/${branch}`])).toBe(sent);
});

test("worktree.add starts the branch at the ref it is given", async () => {
  const home = tempDir("penguin-home-");
  process.env["PENGUIN_HOME"] = home;
  try {
    const { dir, host, vcs } = await repo();
    await commitFile({ dir, host }, "base.txt", "base");
    const from = await git(host, ["rev-parse", "HEAD"]);
    await commitFile({ dir, host }, "later.txt", "later");

    const added = await vcs.worktree.add("feature", { from });
    expect(added.ok).toBe(true);
    const started = await host.exec(["git", "rev-parse", "HEAD"], { cwd: added.path });
    expect(started.stdout.trim()).toBe(from);
    expect(fs.existsSync(path.join(added.path, "later.txt"))).toBe(false);
  } finally {
    delete process.env["PENGUIN_HOME"];
  }
});

test("worktree.add buckets by the repository, not the checkout it was called from", async () => {
  const home = tempDir("penguin-home-");
  process.env["PENGUIN_HOME"] = home;
  try {
    const { dir, host, vcs } = await repo();
    await commitFile({ dir, host }, "base.txt", "base");
    const first = await vcs.worktree.add("one");
    expect(first.ok).toBe(true);

    // A run whose cwd is a worktree of the same repository must land in the same folder.
    const inside = definition.build(hostFor(first.path));
    const second = await inside.worktree.add("two");
    expect(second.ok).toBe(true);
    expect(path.dirname(second.path)).toBe(path.dirname(first.path));
  } finally {
    delete process.env["PENGUIN_HOME"];
  }
});

test("worktree.add reports a branch another worktree holds as one already there", async () => {
  const home = tempDir("penguin-home-");
  process.env["PENGUIN_HOME"] = home;
  try {
    const { dir, host, vcs } = await repo();
    await commitFile({ dir, host }, "base.txt", "base");
    const first = await vcs.worktree.add("feature");
    expect(first.ok).toBe(true);

    // The same branch from a different bucket: git refuses, and the caller is told where it sits.
    process.env["PENGUIN_HOME"] = tempDir("penguin-home-");
    const again = await definition.build(hostFor(dir)).worktree.add("feature");
    expect(again.ok).toBe(false);
    expect(again.exists).toBe(true);
    expect(again.path).toBe(fs.realpathSync(first.path));
  } finally {
    delete process.env["PENGUIN_HOME"];
  }
});

test("sha names the commit a ref points at, and refuses one that does not resolve", async () => {
  const { dir, host, vcs } = await repo();
  await commitFile({ dir, host }, "base.txt", "base");
  const head = await vcs.head();

  const named = await vcs.sha(head.branch);
  expect(named.ok).toBe(true);
  expect(named.sha).toBe(head.sha);

  const missing = await vcs.sha("origin/nothing");
  expect(missing.ok).toBe(false);
  expect(missing.sha).toBe("");
});

test("a base ahead of origin takes the branch only when the branch rebased onto the base itself", async () => {
  const bare = tempDir("penguin-bare-");
  await git(hostFor(bare), ["init", "-q", "--bare"]);
  const home = tempDir("penguin-home-");
  process.env["PENGUIN_HOME"] = home;
  try {
    const ours = await repo();
    await commitFile(ours, "base.txt", "base");
    await git(ours.host, ["remote", "add", "origin", bare]);
    const base = (await ours.vcs.head()).branch;
    await git(ours.host, ["push", "-q", "-u", "origin", base]);
    // A land that never pushed leaves the local base ahead of origin's copy of it.
    await commitFile(ours, "landed.txt", "landed");

    const added = await ours.vcs.worktree.add("feature", { from: `origin/${base}` });
    expect(added.ok).toBe(true);
    fs.writeFileSync(path.join(added.path, "feature.txt"), "feature\n");
    await ours.vcs.stage(["feature.txt"], { cwd: added.path });
    await ours.vcs.commit("test: feature", { cwd: added.path });

    const off = await ours.vcs.merge("feature", { ffOnly: true });
    expect(off.ok).toBe(false);

    const onto = await ours.vcs.rebase.onto(base, { cwd: added.path });
    expect(onto.ok).toBe(true);
    const merged = await ours.vcs.merge("feature", { ffOnly: true });
    expect(merged.ok).toBe(true);
    expect((await ours.vcs.head()).sha).toBe((await ours.vcs.head({ cwd: added.path })).sha);
  } finally {
    delete process.env["PENGUIN_HOME"];
  }
});

async function origin(): Promise<{ bare: string; ours: Awaited<ReturnType<typeof repo>>; base: string }> {
  const bare = tempDir("penguin-bare-");
  await git(hostFor(bare), ["init", "-q", "--bare"]);
  const ours = await repo();
  await commitFile(ours, "base.txt", "base");
  await git(ours.host, ["remote", "add", "origin", bare]);
  const base = (await ours.vcs.head()).branch;
  await git(ours.host, ["push", "-q", "-u", "origin", base]);
  return { bare, ours, base };
}

test("a rebased branch reaches the remote only when the push carries force", async () => {
  const { ours, base } = await origin();
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);
  await commitFile(ours, "feature.txt", "feature");
  expect((await ours.vcs.push("feature")).ok).toBe(true);

  await git(ours.host, ["checkout", "-q", base]);
  await commitFile(ours, "moved.txt", "moved");
  await git(ours.host, ["checkout", "-q", "feature"]);
  expect((await ours.vcs.rebase.onto(base)).ok).toBe(true);

  expect((await ours.vcs.push("feature")).ok).toBe(false);
  expect((await ours.vcs.push("feature", { force: true })).ok).toBe(true);
  expect(await git(ours.host, ["rev-parse", "origin/feature"])).toBe(
    await git(ours.host, ["rev-parse", "HEAD"]),
  );
});

test("force leaves a commit this clone never saw alone", async () => {
  const { bare, ours } = await origin();
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);
  await commitFile(ours, "feature.txt", "feature");
  expect((await ours.vcs.push("feature")).ok).toBe(true);

  const theirsDir = tempDir("penguin-theirs-");
  const theirs = { dir: theirsDir, host: hostFor(theirsDir) };
  await git(theirs.host, ["clone", "-q", bare, "."]);
  await git(theirs.host, ["config", "user.email", "test@test"]);
  await git(theirs.host, ["config", "user.name", "test"]);
  await git(theirs.host, ["checkout", "-q", "feature"]);
  await commitFile(theirs, "reviewed.txt", "reviewed");
  await git(theirs.host, ["push", "-q"]);
  const sent = await git(theirs.host, ["rev-parse", "HEAD"]);

  await commitFile(ours, "more.txt", "more");
  expect((await ours.vcs.push("feature", { force: true })).ok).toBe(false);
  expect(await git(hostFor(bare), ["rev-parse", "feature"])).toBe(sent);
});

test("force still opens a branch the remote does not have yet", async () => {
  const bare = tempDir("penguin-bare-");
  await git(hostFor(bare), ["init", "-q", "--bare"]);
  const ours = await repo();
  await commitFile(ours, "base.txt", "base");
  await git(ours.host, ["remote", "add", "origin", bare]);
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);
  await commitFile(ours, "feature.txt", "feature");

  expect((await ours.vcs.push("feature", { force: true })).ok).toBe(true);
  expect(await git(hostFor(bare), ["rev-parse", "feature"])).toBe(
    await git(ours.host, ["rev-parse", "HEAD"]),
  );
});

function refuse(dir: string): void {
  const hook = path.join(dir, ".git", "hooks", "pre-push");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  fs.chmodSync(hook, 0o755);
}

test("a hook that refuses a push the remote already has does not fail it", async () => {
  const { ours } = await origin();
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);
  await commitFile(ours, "feature.txt", "feature");
  expect((await ours.vcs.push("feature")).ok).toBe(true);

  refuse(ours.dir);
  const sent = await ours.vcs.push("feature");
  expect(sent.ok).toBe(true);
  expect(sent.reason).not.toBe("");
});

test("a hook still stops a push carrying a commit the remote does not have", async () => {
  const { ours } = await origin();
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);
  await commitFile(ours, "feature.txt", "feature");
  expect((await ours.vcs.push("feature")).ok).toBe(true);

  refuse(ours.dir);
  await commitFile(ours, "more.txt", "more");
  expect((await ours.vcs.push("feature")).ok).toBe(false);
});

const LOCKED =
  "error: cannot lock ref 'refs/remotes/origin/main': is at 9a85720 but expected 9cac28b";

/** A host whose git answers from a script, for the failures a real remote will not stage. */
function scripted(answers: CommandResult[]): { host: Host; calls: string[][] } {
  const calls: string[][] = [];
  const host = {
    exec: (argv: string[]): Promise<CommandResult> => {
      calls.push(argv);
      return Promise.resolve(answers[calls.length - 1] ?? { code: 0, stdout: "", stderr: "" });
    },
  } as unknown as Host;
  return { host, calls };
}

test("a fetch a sibling worktree beat to the ref runs again", async () => {
  const { host, calls } = scripted([
    { code: 1, stdout: "", stderr: LOCKED },
    { code: 0, stdout: "", stderr: "" },
  ]);
  expect((await definition.build(host).fetch("main")).ok).toBe(true);
  expect(calls).toHaveLength(2);
});

test("a fetch that fails for another reason is not run again", async () => {
  const { host, calls } = scripted([{ code: 128, stdout: "", stderr: "fatal: no such remote" }]);
  const done = await definition.build(host).fetch("main");
  expect(done.ok).toBe(false);
  expect(done.reason).toBe("fatal: no such remote");
  expect(calls).toHaveLength(1);
});

test("a ref that stays contended gives up with what git said", async () => {
  const locked = { code: 1, stdout: "", stderr: LOCKED };
  const { host, calls } = scripted([locked, locked, locked, locked, locked]);
  const done = await definition.build(host).fetch("main");
  expect(done.ok).toBe(false);
  expect(done.reason).toBe(LOCKED);
  expect(calls).toHaveLength(5);
});

async function conflicting(): Promise<{ ours: Awaited<ReturnType<typeof repo>>; base: string }> {
  const ours = await repo();
  await commitFile(ours, "base.txt", "base");
  const base = (await ours.vcs.head()).branch;
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(ours.dir, "same.txt"), "theirs\n");
  await git(ours.host, ["add", "same.txt"]);
  await git(ours.host, ["commit", "-q", "-m", "feature"]);
  await git(ours.host, ["checkout", "-q", base]);
  fs.writeFileSync(path.join(ours.dir, "same.txt"), "ours\n");
  await git(ours.host, ["add", "same.txt"]);
  await git(ours.host, ["commit", "-q", "-m", "base moves"]);
  await git(ours.host, ["checkout", "-q", "feature"]);
  return { ours, base };
}

test("pending reads the rebase a stopped run left open, and abort clears it", async () => {
  const { ours, base } = await conflicting();
  expect(await ours.vcs.rebase.pending()).toBe(false);

  const onto = await ours.vcs.rebase.onto(base);
  expect(onto.conflicted).toBe(true);
  expect(await ours.vcs.rebase.pending()).toBe(true);

  expect((await ours.vcs.rebase.abort()).ok).toBe(true);
  expect(await ours.vcs.rebase.pending()).toBe(false);
  expect((await ours.vcs.head()).branch).toBe("feature");
});
