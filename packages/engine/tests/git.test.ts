import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Host } from "../src/core/adapter.ts";
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
