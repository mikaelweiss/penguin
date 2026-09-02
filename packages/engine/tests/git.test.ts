import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResult, Host } from "../src/core/adapter.ts";
import { Fault } from "../src/core/errors.ts";
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
  await vcs.stage(["a.txt"]);
  expect((await vcs.commit("test: first")).committed).toBe(true);
  expect((await vcs.dirty()).dirty).toBe(false);
  const head = await vcs.head();
  expect(head.detached).toBe(false);
  expect(head.sha).not.toBe("");
});

test("a commit message with quotes survives intact", async () => {
  const { dir, host, vcs } = await repo();
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  await vcs.stage(["a.txt"]);
  const message = `test: it's "quoted" $(danger)`;
  await vcs.commit(message);
  expect(await git(host, ["log", "-1", "--format=%s"])).toBe(message);
});

test("a commit with nothing to commit is an answer, not a fault", async () => {
  const { dir, host, vcs } = await repo();
  await commitFile({ dir, host }, "base.txt", "base");
  expect((await vcs.commit("test: nothing staged")).committed).toBe(false);
});

test("a commit a hook refuses is a fault the agent gets first", async () => {
  const { dir, vcs } = await repo();
  const hook = path.join(dir, ".git", "hooks", "pre-commit");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, "#!/bin/sh\necho the hook objects\nexit 1\n");
  fs.chmodSync(hook, 0o755);
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  await vcs.stage(["a.txt"]);
  const failing = vcs.commit("test: refused");
  await expect(failing).rejects.toThrow(Fault);
  await expect(failing).rejects.toMatchObject({ fix: "agent" });
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
  expect(pulled.fastForwarded).toBe(false);
  expect(await git(ours.host, ["rev-parse", "HEAD"])).toBe(before);
  expect(fs.existsSync(path.join(ours.dir, "ours.txt"))).toBe(true);

  await ours.vcs.resetHard("FETCH_HEAD");
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
    expect(added.existed).toBe(false);
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
  expect(pulled.fastForwarded).toBe(true);
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

  await ours.vcs.fetch(branch);
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
    expect(added.existed).toBe(false);
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
    expect(first.existed).toBe(false);

    // A run whose cwd is a worktree of the same repository must land in the same folder.
    const inside = definition.build(hostFor(first.path));
    const second = await inside.worktree.add("two");
    expect(second.existed).toBe(false);
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
    expect(first.existed).toBe(false);

    // The same branch from a different bucket: git refuses, and the caller is told where it sits.
    process.env["PENGUIN_HOME"] = tempDir("penguin-home-");
    const again = await definition.build(hostFor(dir)).worktree.add("feature");
    expect(again.existed).toBe(true);
    expect(again.path).toBe(fs.realpathSync(first.path));
  } finally {
    delete process.env["PENGUIN_HOME"];
  }
});

test("worktree.add refuses a folder the repository has no worktree for", async () => {
  const home = tempDir("penguin-home-");
  process.env["PENGUIN_HOME"] = home;
  try {
    const { dir, host, vcs } = await repo();
    await commitFile({ dir, host }, "base.txt", "base");
    const added = await vcs.worktree.add("feature");

    // What a cleanup tool outside the run leaves: the checkout gone, a folder standing in its place.
    await vcs.worktree.remove(added.path);
    fs.mkdirSync(added.path, { recursive: true });
    fs.writeFileSync(path.join(added.path, "state.json"), "{}");

    await expect(vcs.worktree.add("feature")).rejects.toThrow(/no worktree for/);
    expect(fs.existsSync(path.join(added.path, "state.json"))).toBe(true);
  } finally {
    delete process.env["PENGUIN_HOME"];
  }
});

test("sha names the commit a ref points at, and refuses one that does not resolve", async () => {
  const { dir, host, vcs } = await repo();
  await commitFile({ dir, host }, "base.txt", "base");
  const head = await vcs.head();

  const named = await vcs.sha(head.branch);
  expect(named.sha).toBe(head.sha);

  await expect(vcs.sha("origin/nothing")).rejects.toThrow(Fault);
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
    fs.writeFileSync(path.join(added.path, "feature.txt"), "feature\n");
    await ours.vcs.stage(["feature.txt"], { cwd: added.path });
    await ours.vcs.commit("test: feature", { cwd: added.path });

    await expect(ours.vcs.merge("feature", { ffOnly: true })).rejects.toThrow(Fault);

    const onto = await ours.vcs.rebase.onto(base, { cwd: added.path });
    expect(onto.conflicted).toBe(false);
    await ours.vcs.merge("feature", { ffOnly: true });
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

async function cloneOf(bare: string): Promise<{ dir: string; host: Host }> {
  const dir = tempDir("penguin-theirs-");
  const host = hostFor(dir);
  await git(host, ["clone", "-q", bare, "."]);
  await git(host, ["config", "user.email", "test@test"]);
  await git(host, ["config", "user.name", "test"]);
  return { dir, host };
}

test("a rebased branch reaches the remote only when the push carries force", async () => {
  const { ours, base } = await origin();
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);
  await commitFile(ours, "feature.txt", "feature");
  await ours.vcs.raw.push("feature");

  await git(ours.host, ["checkout", "-q", base]);
  await commitFile(ours, "moved.txt", "moved");
  await git(ours.host, ["checkout", "-q", "feature"]);
  expect((await ours.vcs.rebase.onto(base)).conflicted).toBe(false);

  await expect(ours.vcs.raw.push("feature")).rejects.toThrow(Fault);
  await ours.vcs.raw.push("feature", { force: true });
  expect(await git(ours.host, ["rev-parse", "origin/feature"])).toBe(
    await git(ours.host, ["rev-parse", "HEAD"]),
  );
});

test("force leaves a commit this clone never saw alone", async () => {
  const { bare, ours } = await origin();
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);
  await commitFile(ours, "feature.txt", "feature");
  await ours.vcs.raw.push("feature");

  const theirs = await cloneOf(bare);
  await git(theirs.host, ["checkout", "-q", "feature"]);
  await commitFile(theirs, "reviewed.txt", "reviewed");
  await git(theirs.host, ["push", "-q"]);
  const sent = await git(theirs.host, ["rev-parse", "HEAD"]);

  await commitFile(ours, "more.txt", "more");
  await expect(ours.vcs.raw.push("feature", { force: true })).rejects.toThrow(Fault);
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

  await ours.vcs.raw.push("feature", { force: true });
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
  await ours.vcs.raw.push("feature");

  refuse(ours.dir);
  await ours.vcs.raw.push("feature");
});

test("a hook still stops a push carrying a commit the remote does not have", async () => {
  const { ours } = await origin();
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);
  await commitFile(ours, "feature.txt", "feature");
  await ours.vcs.raw.push("feature");

  refuse(ours.dir);
  await commitFile(ours, "more.txt", "more");
  await expect(ours.vcs.raw.push("feature")).rejects.toThrow(Fault);
});

test("sync puts the branch on a base that moved and lands it on origin", async () => {
  const { bare, ours, base } = await origin();
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);
  await commitFile(ours, "feature.txt", "feature");

  const theirs = await cloneOf(bare);
  await commitFile(theirs, "moved.txt", "moved");
  await git(theirs.host, ["push", "-q"]);

  const synced = await ours.vcs.sync("feature", base);
  expect(synced.conflicted).toBe(false);
  if (!synced.conflicted) {
    expect(synced.same).toBe(false);
    expect(synced.baseSha).not.toBe("");
  }
  expect(await git(hostFor(bare), ["rev-parse", "feature"])).toBe(
    await git(ours.host, ["rev-parse", "HEAD"]),
  );
  // The branch now sits on the moved base.
  expect(fs.existsSync(path.join(ours.dir, "moved.txt"))).toBe(true);
});

test("sync answers same for a branch with nothing over its base, and pushes nothing", async () => {
  const { bare, ours, base } = await origin();
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);

  const synced = await ours.vcs.sync("feature", base);
  expect(synced).toMatchObject({ conflicted: false, same: true });
  const listed = await hostFor(bare).exec(["git", "rev-parse", "--verify", "feature"]);
  expect(listed.code).not.toBe(0);
});

test("sync hands conflicts back with the rebase dropped and the tree clean", async () => {
  const { bare, ours, base } = await origin();
  fs.writeFileSync(path.join(ours.dir, "same.txt"), "ours\n");
  await git(ours.host, ["add", "same.txt"]);
  await git(ours.host, ["commit", "-q", "-m", "base holds same.txt"]);
  await git(ours.host, ["push", "-q"]);
  await git(ours.host, ["checkout", "-q", "-b", "feature", "HEAD~1"]);
  fs.writeFileSync(path.join(ours.dir, "same.txt"), "theirs\n");
  await git(ours.host, ["add", "same.txt"]);
  await git(ours.host, ["commit", "-q", "-m", "feature holds same.txt"]);

  const synced = await ours.vcs.sync("feature", base);
  expect(synced.conflicted).toBe(true);
  if (synced.conflicted) expect(synced.files).toEqual(["same.txt"]);
  expect(await ours.vcs.rebase.pending()).toBe(false);
  expect((await ours.vcs.head()).branch).toBe("feature");
  expect((await ours.vcs.dirty()).dirty).toBe(false);
  void bare;
});

test("sync refuses when origin holds commits of the branch this checkout has not seen", async () => {
  const { bare, ours, base } = await origin();
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);
  await commitFile(ours, "feature.txt", "feature");
  await ours.vcs.raw.push("feature");

  const theirs = await cloneOf(bare);
  await git(theirs.host, ["checkout", "-q", "feature"]);
  await commitFile(theirs, "reviewed.txt", "reviewed");
  await git(theirs.host, ["push", "-q"]);

  await commitFile(ours, "more.txt", "more");
  const failing = ours.vcs.sync("feature", base);
  await expect(failing).rejects.toThrow("has commits this checkout does not");
  expect(await git(hostFor(bare), ["rev-parse", "feature"])).toBe(
    await git(theirs.host, ["rev-parse", "HEAD"]),
  );
});

test("sync refuses a dirty tree before it touches anything", async () => {
  const { ours, base } = await origin();
  await git(ours.host, ["checkout", "-q", "-b", "feature"]);
  await commitFile(ours, "feature.txt", "feature");
  fs.writeFileSync(path.join(ours.dir, "loose.txt"), "loose\n");

  await expect(ours.vcs.sync("feature", base)).rejects.toThrow("uncommitted changes");
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
  await definition.build(host).fetch("main");
  expect(calls).toHaveLength(2);
});

test("a fetch that fails for another reason is not run again", async () => {
  const { host, calls } = scripted([{ code: 128, stdout: "", stderr: "fatal: no such remote" }]);
  await expect(definition.build(host).fetch("main")).rejects.toThrow("fatal: no such remote");
  expect(calls).toHaveLength(1);
});

test("a ref that stays contended gives up with what git said", async () => {
  const locked = { code: 1, stdout: "", stderr: LOCKED };
  const { host, calls } = scripted([locked, locked, locked, locked, locked]);
  await expect(definition.build(host).fetch("main")).rejects.toThrow(LOCKED);
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

  await ours.vcs.rebase.abort();
  expect(await ours.vcs.rebase.pending()).toBe(false);
  expect((await ours.vcs.head()).branch).toBe("feature");
});

test("check flags a folder that is not a repository, and passes a clean one", async () => {
  const check = definition.check;
  if (check === undefined) throw new Error("the git adapter defines no check");
  const dir = tempDir("penguin-plain-");
  const bad = await check(hostFor(dir));
  expect(bad.some((problem) => problem.includes("not a git repository"))).toBe(true);

  const { ours } = await origin();
  expect(await check(ours.host)).toEqual([]);
});

test("status lists each untracked file on its own, so every path it names is stageable", async () => {
  const { dir, host, vcs } = await repo();
  await commitFile({ dir, host }, "kept.txt", "base");
  fs.mkdirSync(path.join(dir, "notes"));
  fs.writeFileSync(path.join(dir, "notes", "one.md"), "one\n");
  fs.writeFileSync(path.join(dir, "notes", "two.md"), "two\n");
  fs.writeFileSync(path.join(dir, "kept.txt"), "changed\n");

  const { files } = await vcs.status();
  expect(files.map((file) => file.path).sort()).toEqual([
    "kept.txt",
    "notes/one.md",
    "notes/two.md",
  ]);
  expect(files.find((file) => file.path === "kept.txt")?.status.trim()).toBe("M");
  // A folder is not a path git stages by content, so the files inside it are what status names.
  await vcs.stage(["notes/one.md"]);
  expect((await vcs.commit("test: one note")).committed).toBe(true);
});

test("status keeps a rename's new path and drops the name it came from", async () => {
  const { dir, host, vcs } = await repo();
  await commitFile({ dir, host }, "old.txt", "base");
  await git(host, ["mv", "old.txt", "new.txt"]);

  const { files } = await vcs.status();
  expect(files).toHaveLength(1);
  expect(files[0]?.path).toBe("new.txt");
  expect(files[0]?.status.trim()).toBe("R");
});

test("diff carries untracked contents only when asked for them", async () => {
  const { dir, host, vcs } = await repo();
  await commitFile({ dir, host }, "tracked.txt", "base");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "edited\n");
  fs.writeFileSync(path.join(dir, "fresh.txt"), "brand new line\n");

  const tracked = await vcs.diff();
  expect(tracked.text).toContain("edited");
  expect(tracked.text).not.toContain("brand new line");

  const whole = await vcs.diff({ untracked: true });
  expect(whole.text).toContain("edited");
  expect(whole.text).toContain("brand new line");
  expect(whole.truncated).toBe(false);
});

test("diff says so when it cut a change too large to hand on whole", async () => {
  const { dir, host, vcs } = await repo();
  await commitFile({ dir, host }, "big.txt", "base");
  fs.writeFileSync(path.join(dir, "big.txt"), "a line of text\n".repeat(2000));

  const cut = await vcs.diff({ limit: 500 });
  expect(cut.truncated).toBe(true);
  expect(cut.text).toHaveLength(500);
});

test("diff reads a tree that has no commit behind it", async () => {
  const { dir, vcs } = await repo();
  fs.writeFileSync(path.join(dir, "first.txt"), "the very first line\n");

  const whole = await vcs.diff({ untracked: true });
  expect(whole.text).toContain("the very first line");
});

test("subjects reads the newest lines, and a repository with no commit has none", async () => {
  const { dir, host, vcs } = await repo();
  expect((await vcs.subjects(20)).subjects).toEqual([]);

  await commitFile({ dir, host }, "a.txt", "test: first");
  await commitFile({ dir, host }, "b.txt", "test: second");
  await commitFile({ dir, host }, "c.txt", "test: third");

  expect((await vcs.subjects(20)).subjects).toEqual(["test: third", "test: second", "test: first"]);
  expect((await vcs.subjects(2)).subjects).toEqual(["test: third", "test: second"]);
});

test("onto with from carries only the branch's own commits over a parent that was rewritten", async () => {
  const { dir, host, vcs } = await repo();
  await commitFile({ dir, host }, "base.txt", "base");
  const base = (await vcs.head()).branch;
  await git(host, ["checkout", "-q", "-b", "parent"]);
  await commitFile({ dir, host }, "parent.txt", "parent");
  const forkedAt = (await vcs.head()).sha;
  await git(host, ["checkout", "-q", "-b", "child"]);
  await commitFile({ dir, host }, "child.txt", "child");
  // The parent is squashed onto the base, as a merge would do, so its old commit is history.
  await git(host, ["checkout", "-q", base]);
  await commitFile({ dir, host }, "parent.txt", "parent");
  await git(host, ["checkout", "-q", "child"]);

  const landed = await vcs.rebase.onto(base, { from: forkedAt });
  expect(landed.conflicted).toBe(false);
  const log = await git(host, ["log", "--format=%s", `${base}..child`]);
  expect(log.split("\n")).toEqual(["child"]);
});

test("against reads what the branch holds over the base, and stat says it in one block", async () => {
  const { dir, host, vcs } = await repo();
  await commitFile({ dir, host }, "base.txt", "base");
  const base = (await vcs.head()).branch;
  await git(host, ["checkout", "-q", "-b", "feature"]);
  await commitFile({ dir, host }, "feature.txt", "feat: the work");
  // The base moves under the branch, and the three-dot range leaves that out.
  await git(host, ["checkout", "-q", base]);
  await commitFile({ dir, host }, "other.txt", "other");
  await git(host, ["checkout", "-q", "feature"]);

  const patch = await vcs.against(base);
  expect(patch.text).toContain("feature.txt");
  expect(patch.text).not.toContain("other.txt");
  expect(patch.truncated).toBe(false);
  const stat = await vcs.against(base, { stat: true });
  expect(stat.text).toContain("1 file changed");
  expect((await vcs.subjects(20, { range: `${base}..HEAD` })).subjects).toEqual(["feat: the work"]);
});

test("a diff larger than the limit comes back cut, and says so", async () => {
  const { dir, host, vcs } = await repo();
  await commitFile({ dir, host }, "base.txt", "base");
  const base = (await vcs.head()).branch;
  await git(host, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(dir, "big.txt"), "line\n".repeat(2000));
  await git(host, ["add", "big.txt"]);
  await git(host, ["commit", "-q", "-m", "feat: a lot"]);

  const cut = await vcs.against(base, { limit: 500 });
  expect(cut.truncated).toBe(true);
  expect(cut.text.length).toBe(500);
});

test("read hands back the file whole, and answers for a path holding nothing", async () => {
  const { dir, host, vcs } = await repo();
  await commitFile({ dir, host }, "a.txt", "test: first");

  expect(await vcs.read("a.txt")).toEqual({ there: true, text: "a.txt\n", truncated: false });
  expect(await vcs.read("a.txt", { limit: 3 })).toEqual({
    there: true,
    text: "a.t",
    truncated: true,
  });
  expect(await vcs.read("gone.txt")).toEqual({ there: false, text: "", truncated: false });
  expect((await vcs.log(1)).text).toContain("test: first");
});

test("a stopped rebase names its conflicted files and the patch it is replaying", async () => {
  const { dir, host, vcs } = await repo();
  fs.writeFileSync(path.join(dir, "same.txt"), "base\n");
  await git(host, ["add", "same.txt"]);
  await git(host, ["commit", "-q", "-m", "base"]);
  const base = (await vcs.head()).branch;
  await git(host, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(dir, "same.txt"), "theirs\n");
  await git(host, ["add", "same.txt"]);
  await git(host, ["commit", "-q", "-m", "feat: theirs"]);
  await git(host, ["checkout", "-q", base]);
  fs.writeFileSync(path.join(dir, "same.txt"), "ours\n");
  await git(host, ["add", "same.txt"]);
  await git(host, ["commit", "-q", "-m", "ours"]);
  await git(host, ["checkout", "-q", "feature"]);

  const landed = await vcs.rebase.onto(base);
  expect(landed.conflicted).toBe(true);
  expect((await vcs.rebase.conflicts()).files).toEqual(["same.txt"]);
  expect((await vcs.rebase.patch()).text).toContain("feat: theirs");
  expect((await vcs.read("same.txt")).text).toContain("<<<<<<<");
  await vcs.rebase.abort();
  expect((await vcs.rebase.patch()).text).toBe("");
});
