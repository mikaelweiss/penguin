import fs from "node:fs";
import path from "node:path";
import { adapter, Fault, type CommandResult } from "penguin";

type Rebase = { conflicted: boolean; files: string[] };

/** One path the tree holds against HEAD, with git's own two-letter code. */
type Change = { status: string; path: string };

/** How much diff one read hands back. A prompt has to hold it, so a huge change is cut, not sent whole. */
const DIFF_LIMIT = 60000;

/** How much of a file one read hands back, for the same reason. */
const FILE_LIMIT = 20000;

/** `truncated` says the tail was cut, so a reader knows it has not seen all of it. */
function capped(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

type Sync =
  | { conflicted: true; files: string[] }
  | { conflicted: false; sha: string; baseSha: string; same: boolean };

export default adapter({
  role: "vcs",
  name: "git",
  description:
    "git working copies: staging, commits, worktrees, and sync, which puts a branch on its base and on origin",
  async check(host) {
    const repo = await host.exec(["git", "rev-parse", "--git-dir"]);
    if (repo.code !== 0) return [`${host.cwd} is not a git repository`];
    const origin = await host.exec(["git", "remote", "get-url", "origin"]);
    if (origin.code !== 0) {
      return ["the checkout has no origin remote. git remote add origin <url> sets one."];
    }
    return [];
  },
  build: (host) => {
    const git = (args: string[], cwd?: string): Promise<CommandResult> =>
      host.exec(["git", ...args], { cwd });

    const saidOf = (done: CommandResult): string => (done.stdout + done.stderr).trim();

    async function unmerged(cwd: string | undefined): Promise<string[]> {
      const done = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
      const text = done.stdout.trim();
      return text === "" ? [] : text.split("\n");
    }

    /** Conflicts are the caller's answer; anything else that stops a rebase is a fault. */
    async function rebased(
      running: Promise<CommandResult>,
      cwd: string | undefined,
      onto: string,
    ): Promise<Rebase> {
      const done = await running;
      if (done.code === 0) return { conflicted: false, files: [] };
      const files = await unmerged(cwd);
      if (files.length > 0) return { conflicted: true, files };
      throw new Fault(`the rebase onto ${onto} failed:\n\n${saidOf(done)}`);
    }

    /** Every worktree of a clone shares one ref store, so a sibling's fetch can win the write. */
    function contended(said: string): boolean {
      return /cannot lock ref|unable to update local ref|config\.lock/i.test(said);
    }

    const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

    /** A contended write leaves the ref at the winner's value, which the retry reads before it writes. */
    async function fetching(ref: string, cwd: string | undefined): Promise<void> {
      for (let attempt = 1; ; attempt++) {
        const done = await git(["fetch", "origin", ref], cwd);
        if (done.code === 0) return;
        const said = done.stderr.trim();
        if (attempt === 5 || !contended(said)) throw new Fault(said);
        await pause(attempt * 100);
      }
    }

    /** Where the repository has branch checked out, empty when no worktree holds it. */
    async function checkedOut(branch: string): Promise<string> {
      const listed = await git(["worktree", "list", "--porcelain"]);
      if (listed.code !== 0) return "";
      let dir = "";
      for (const line of listed.stdout.split("\n")) {
        if (line.startsWith("worktree ")) dir = line.slice("worktree ".length).trim();
        if (line.trim() === `branch refs/heads/${branch}`) return dir;
      }
      return "";
    }

    /** Whether the repository holds a worktree at target, which a folder standing there is not. */
    async function registered(target: string): Promise<boolean> {
      const listed = await git(["worktree", "list", "--porcelain"]);
      if (listed.code !== 0) return false;
      const here = fs.realpathSync(target);
      return listed.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .some((line) => path.resolve(line.slice("worktree ".length).trim()) === here);
    }

    async function headOf(
      cwd: string | undefined,
    ): Promise<{ branch: string; sha: string; detached: boolean }> {
      const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
      const sha = await git(["rev-parse", "--short", "HEAD"], cwd);
      if (branch.code !== 0 || sha.code !== 0) {
        throw new Fault((branch.stderr + sha.stderr).trim());
      }
      const name = branch.stdout.trim();
      return { branch: name, sha: sha.stdout.trim(), detached: name === "HEAD" };
    }

    async function dirtyOf(cwd: string | undefined): Promise<boolean> {
      const done = await git(["status", "--porcelain"], cwd);
      if (done.code !== 0) throw new Fault(done.stderr.trim());
      return done.stdout.trim() !== "";
    }

    /** Untracked files listed one by one, so every path the answer names is one git can stage. */
    async function changesIn(cwd: string | undefined): Promise<Change[]> {
      const done = await git(["status", "--porcelain", "-z", "--untracked-files=all"], cwd);
      if (done.code !== 0) throw new Fault(done.stderr.trim());
      const entries = done.stdout.split("\0").filter((entry) => entry !== "");
      const files: Change[] = [];
      for (let at = 0; at < entries.length; at++) {
        const entry = entries[at] ?? "";
        const code = entry.slice(0, 2);
        files.push({ status: code, path: entry.slice(3) });
        // A rename or a copy prints where the path came from as the next entry.
        if (code.startsWith("R") || code.startsWith("C")) at++;
      }
      return files;
    }

    async function hasHead(cwd: string | undefined): Promise<boolean> {
      return (await git(["rev-parse", "--verify", "HEAD"], cwd)).code === 0;
    }

    /**
     * An untracked file is in no diff git will print, so it is diffed against nothing.
     * `--no-index` reports a difference with code 1, which is the whole point of the call.
     */
    async function untrackedDiff(file: string, cwd: string | undefined): Promise<string> {
      const done = await git(["diff", "--no-index", "--", "/dev/null", file], cwd);
      return done.stdout;
    }

    async function shaOf(ref: string, cwd: string | undefined): Promise<string> {
      const done = await git(["rev-parse", "--short", "--verify", `${ref}^{commit}`], cwd);
      if (done.code !== 0) throw new Fault(done.stderr.trim());
      return done.stdout.trim();
    }

    async function pendingRebase(cwd: string | undefined): Promise<boolean> {
      for (const name of ["rebase-merge", "rebase-apply"]) {
        const done = await git(["rev-parse", "--git-path", name], cwd);
        const where = done.stdout.trim();
        if (done.code !== 0 || where === "") continue;
        if (fs.existsSync(path.resolve(host.cwd, cwd ?? ".", where))) return true;
      }
      return false;
    }

    /**
     * A pre-push hook fails a push whose commits are already up, so origin's own
     * ref decides whether the branch reached the remote. `stale` means the remote
     * moved under the lease, which a caller can converge on; everything else is a fault.
     */
    async function pushing(
      branch: string,
      cwd: string | undefined,
      force: boolean,
    ): Promise<{ landed: boolean; stale: boolean; reason: string }> {
      const how = force ? ["--force-with-lease"] : [];
      for (let attempt = 1; ; attempt++) {
        const done = await git(["push", "-u", ...how, "origin", branch], cwd);
        const said = saidOf(done);
        if (done.code === 0) return { landed: true, stale: false, reason: "" };
        // Parallel worktrees share one .git, so two setting an upstream at once race on its config lock.
        if (attempt < 3 && contended(said)) {
          await pause(1000);
          continue;
        }
        const there = await git(["ls-remote", "origin", `refs/heads/${branch}`], cwd);
        const remote = there.stdout.trim().split(/\s+/)[0] ?? "";
        const local = await git(["rev-parse", branch], cwd);
        if (there.code === 0 && remote !== "" && remote === local.stdout.trim()) {
          return { landed: true, stale: false, reason: said };
        }
        const stale = /stale info|fetch first|non-fast-forward|\[rejected\]/.test(said);
        return { landed: false, stale, reason: said };
      }
    }

    return {
      async stage(files: string[], options?: { cwd?: string }): Promise<void> {
        const done = await git(["add", "--", ...files], options?.cwd);
        if (done.code !== 0) throw new Fault(done.stderr.trim());
      },
      /**
       * `committed: false` means there was nothing to commit, which a resume
       * reads as its no-op. Hooks are what usually refuse a real commit, and
       * those are the agent's to clear.
       */
      async commit(message: string, options?: { cwd?: string }): Promise<{ committed: boolean }> {
        const done = await git(["commit", "-m", message], options?.cwd);
        if (done.code === 0) return { committed: true };
        const said = saidOf(done);
        if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(said)) {
          return { committed: false };
        }
        throw new Fault(said, { fix: "agent" });
      },
      async dirty(options?: { cwd?: string }): Promise<{ dirty: boolean }> {
        return { dirty: await dirtyOf(options?.cwd) };
      },
      /** Every path the tree changed against HEAD, each one stageable as it is spelled. */
      async status(options?: { cwd?: string }): Promise<{ files: Change[] }> {
        return { files: await changesIn(options?.cwd) };
      },
      /**
       * What the tree changed, as text: the tracked diff against HEAD, then each
       * untracked file's content. `truncated` means the change was larger than
       * `limit` and the tail was cut, so a reader knows it has not seen all of it.
       */
      async diff(
        options?: { cwd?: string; untracked?: boolean; limit?: number },
      ): Promise<{ text: string; truncated: boolean }> {
        const cwd = options?.cwd;
        const limit = options?.limit ?? DIFF_LIMIT;
        const against = (await hasHead(cwd)) ? ["diff", "HEAD"] : ["diff", "--cached"];
        const tracked = await git(against, cwd);
        if (tracked.code !== 0) throw new Fault(tracked.stderr.trim());
        const parts = [tracked.stdout];
        if (options?.untracked === true) {
          for (const change of await changesIn(cwd)) {
            if (change.status !== "??") continue;
            if (parts.join("").length >= limit) break;
            parts.push(await untrackedDiff(change.path, cwd));
          }
        }
        return capped(parts.join(""), limit);
      },
      /**
       * What HEAD changed against base, as text. The three-dot range reads from
       * where the two parted, so commits base gained since are not read as the
       * branch's work. `stat` asks for the summary instead of the patch.
       */
      async against(
        base: string,
        options?: { cwd?: string; stat?: boolean; limit?: number },
      ): Promise<{ text: string; truncated: boolean }> {
        const how = options?.stat === true ? ["--stat"] : [];
        const done = await git(["diff", ...how, `${base}...HEAD`], options?.cwd);
        if (done.code !== 0) throw new Fault(done.stderr.trim());
        return capped(done.stdout, options?.limit ?? DIFF_LIMIT);
      },
      /**
       * What the working tree holds at file, conflict markers and all. `there` is
       * false when nothing stands at the path, which one side of a conflict deleting
       * a file leaves behind.
       */
      async read(
        file: string,
        options?: { cwd?: string; limit?: number },
      ): Promise<{ there: boolean; text: string; truncated: boolean }> {
        const where = path.resolve(host.cwd, options?.cwd ?? ".", file);
        if (!fs.existsSync(where)) return { there: false, text: "", truncated: false };
        const text = fs.readFileSync(where, "utf8");
        return { there: true, ...capped(text, options?.limit ?? FILE_LIMIT) };
      },
      /** The newest subject lines, which are the only record of how this repository writes them. */
      async subjects(
        count: number,
        options?: { cwd?: string; range?: string },
      ): Promise<{ subjects: string[] }> {
        const range = options?.range === undefined ? [] : [options.range];
        const done = await git(["log", `-${count}`, "--format=%s", ...range], options?.cwd);
        if (done.code !== 0) return { subjects: [] };
        return { subjects: done.stdout.split("\n").filter((line) => line.trim() !== "") };
      },
      /** The newest commits as git prints them, message and all. Empty when git prints none. */
      async log(count: number, options?: { cwd?: string }): Promise<{ text: string }> {
        const done = await git(["log", `-${count}`], options?.cwd);
        return { text: done.code === 0 ? done.stdout.trim() : "" };
      },
      async head(
        options?: { cwd?: string },
      ): Promise<{ branch: string; sha: string; detached: boolean }> {
        return headOf(options?.cwd);
      },
      /** The commit a ref names. A ref that does not resolve is a fault, never a guess. */
      async sha(ref: string, options?: { cwd?: string }): Promise<{ sha: string }> {
        return { sha: await shaOf(ref, options?.cwd) };
      },
      /** The branch origin calls its default. Empty when origin/HEAD is unset, never a guess. */
      async defaultBranch(options?: { cwd?: string }): Promise<{ branch: string }> {
        const done = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], options?.cwd);
        const branch = done.stdout.trim().replace(/^origin\//, "");
        return { branch: done.code === 0 ? branch : "" };
      },
      async fetch(ref: string, options?: { cwd?: string }): Promise<void> {
        await fetching(ref, options?.cwd);
      },
      /** Fast-forwards onto the fetched ref. Diverged histories are the caller's answer, nothing is discarded. */
      async pull(ref: string, options?: { cwd?: string }): Promise<{ fastForwarded: boolean }> {
        await fetching(ref, options?.cwd);
        const merged = await git(["merge", "--ff-only", "FETCH_HEAD"], options?.cwd);
        return { fastForwarded: merged.code === 0 };
      },
      /** Discards local commits and changes to match the ref. The name is the warning. */
      async resetHard(ref: string, options?: { cwd?: string }): Promise<void> {
        const done = await git(["reset", "--hard", ref], options?.cwd);
        if (done.code !== 0) throw new Fault(saidOf(done));
      },
      async merge(branch: string, options?: { cwd?: string; ffOnly?: boolean }): Promise<void> {
        const how = options?.ffOnly === true ? ["--ff-only"] : [];
        const done = await git(["merge", ...how, branch], options?.cwd);
        if (done.code !== 0) throw new Fault(saidOf(done));
      },
      /**
       * The branch on its base and on origin, converged: fetch, rebase, push with
       * lease, and again when the base or the remote moved meanwhile. Conflicts
       * come back as the answer with the rebase dropped, so the tree is clean for
       * whoever resolves them. `same` means the branch has nothing over the base.
       * `from` names the commit the branch was cut from, so a base rewritten or
       * squashed under it replays none of its old commits.
       */
      async sync(
        branch: string,
        base: string,
        options?: { cwd?: string; local?: boolean; from?: string },
      ): Promise<Sync> {
        const cwd = options?.cwd;
        const onto = options?.local === true ? base : `origin/${base}`;
        const replay =
          options?.from === undefined ? ["rebase", onto] : ["rebase", "--onto", onto, options.from];
        for (let pass = 1; pass <= 5; pass++) {
          // A rebase a dead run left open is dropped; this pass replays it whole.
          if (await pendingRebase(cwd)) await git(["rebase", "--abort"], cwd);
          const head = await headOf(cwd);
          if (head.detached) throw new Fault("the checkout is detached, so there is no branch to sync");
          if (head.branch !== branch) {
            throw new Fault(`the checkout is on ${head.branch}, not ${branch}`);
          }
          if (await dirtyOf(cwd)) {
            throw new Fault(`${branch} has uncommitted changes. Commit or drop them first.`);
          }
          if (options?.local !== true) await fetching(base, cwd);
          const landed = await rebased(git(replay, cwd), cwd, onto);
          if (landed.conflicted) {
            await git(["rebase", "--abort"], cwd);
            return { conflicted: true, files: landed.files };
          }
          const baseSha = await shaOf(onto, cwd);
          const sha = (await headOf(cwd)).sha;
          if (sha === baseSha) return { conflicted: false, sha, baseSha, same: true };
          const sent = await pushing(branch, cwd, true);
          if (sent.landed) return { conflicted: false, sha, baseSha, same: false };
          if (!sent.stale) throw new Fault(sent.reason, { fix: "agent" });
          // The lease refused, so origin/branch holds commits this pass has not seen.
          await fetching(branch, cwd);
          const theirs = await git(
            ["merge-base", "--is-ancestor", `origin/${branch}`, branch],
            cwd,
          );
          if (theirs.code !== 0) {
            throw new Fault(
              `origin/${branch} has commits this checkout does not. Bring them in first, then run again.`,
            );
          }
        }
        throw new Fault(`the push of ${branch} kept losing to a moving remote`);
      },
      branch: {
        async create(name: string, options?: { cwd?: string }): Promise<void> {
          const done = await git(["checkout", "-b", name], options?.cwd);
          if (done.code !== 0) throw new Fault(saidOf(done));
        },
      },
      raw: {
        /** One push, no convergence. sync is the plain path; this is the escape hatch. */
        async push(branch: string, options?: { cwd?: string; force?: boolean }): Promise<void> {
          const sent = await pushing(branch, options?.cwd, options?.force === true);
          if (!sent.landed) throw new Fault(sent.reason, { fix: "agent" });
        },
      },
      rebase: {
        /**
         * The branch's own commits onto ref. `from` names the commit the branch was cut from,
         * so a parent whose history was rewritten under it is not replayed with it.
         */
        onto(ref: string, options?: { cwd?: string; from?: string }): Promise<Rebase> {
          const args = options?.from === undefined ? ["rebase", ref] : ["rebase", "--onto", ref, options.from];
          return rebased(git(args, options?.cwd), options?.cwd, ref);
        },
        continue(options?: { cwd?: string }): Promise<Rebase> {
          // GIT_EDITOR stops the continue from opening an editor. The string is constant, so shell is safe.
          return rebased(
            host.shell("GIT_EDITOR=true git rebase --continue", { cwd: options?.cwd }),
            options?.cwd,
            "the open rebase",
          );
        },
        async abort(options?: { cwd?: string }): Promise<void> {
          const done = await git(["rebase", "--abort"], options?.cwd);
          if (done.code !== 0) throw new Fault(done.stderr.trim());
        },
        /** The commit the open rebase is replaying, message and patch. Empty when git prints none. */
        async patch(
          options?: { cwd?: string; limit?: number },
        ): Promise<{ text: string; truncated: boolean }> {
          const done = await git(["rebase", "--show-current-patch"], options?.cwd);
          if (done.code !== 0) return { text: "", truncated: false };
          return capped(done.stdout, options?.limit ?? DIFF_LIMIT);
        },
        /** The paths the open rebase stopped on, as git reports them unmerged. */
        async conflicts(options?: { cwd?: string }): Promise<{ files: string[] }> {
          return { files: await unmerged(options?.cwd) };
        },
        /** Whether a rebase is open in the worktree, read off the state folder git keeps for one. */
        async pending(options?: { cwd?: string }): Promise<boolean> {
          return pendingRebase(options?.cwd);
        },
      },
      worktree: {
        /**
         * A worktree for the branch. `existed` means one already holds it at
         * `path`, which is the caller's answer to settle, not a fault.
         */
        async add(
          name: string,
          options?: { ref?: string; from?: string },
        ): Promise<{ path: string; existed: boolean }> {
          // The note tells frontends where the run's work moved, so the terminal and diff follow.
          const moved = (dir: string): void => {
            fs.appendFileSync(
              path.join(host.run.dir, "run.jsonl"),
              `${JSON.stringify({ at: new Date().toISOString(), dir })}\n`,
            );
          };
          // The repository, not the checkout: a run started inside a worktree buckets with the
          // clone it came from, or it loses sight of every worktree an earlier run cut.
          const common = await git(["rev-parse", "--git-common-dir"]);
          const gitdir = common.stdout.trim();
          const repo = gitdir === "" ? host.cwd : path.dirname(path.resolve(host.cwd, gitdir));
          const base = host.config("worktrees") ?? path.join(host.home, "worktrees");
          const target = path.join(base, path.basename(repo), name);
          // A branch git already holds is the same "one is already there" the caller answers,
          // whatever folder holds it.
          const held = options?.ref === undefined ? await checkedOut(name) : "";
          if (held !== "") return { path: held, existed: true };
          if (fs.existsSync(target)) {
            if (await registered(target)) return { path: target, existed: true };
            // A folder git has no worktree for takes every command run in it down with
            // "not a git repository", and whatever a run writes there reaches no branch.
            throw new Fault(
              `a folder sits at ${target} that this repository has no worktree for. Something outside the run removed the worktree and left the folder. Keep what is in it if it matters, delete it, and run this again.`,
            );
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (options?.ref !== undefined) {
            await fetching(options.ref, undefined);
            const done = await git(["worktree", "add", "--detach", target, "FETCH_HEAD"]);
            if (done.code !== 0) throw new Fault(done.stderr.trim());
            moved(target);
            return { path: target, existed: false };
          }
          // A local ref, so a worktree can start on a commit that has never reached the remote.
          const start = options?.from === undefined ? [] : [options.from];
          const done = await git(["worktree", "add", "--no-track", "-b", name, target, ...start]);
          if (done.code === 0) {
            moved(target);
            return { path: target, existed: false };
          }
          // The branch already exists when a prior run made it; the worktree checks it out instead.
          if (/already exists/.test(done.stderr)) {
            const reused = await git(["worktree", "add", target, name]);
            if (reused.code !== 0) throw new Fault(reused.stderr.trim());
            moved(target);
            return { path: target, existed: false };
          }
          throw new Fault(done.stderr.trim());
        },
        async remove(target: string, options?: { force?: boolean }): Promise<void> {
          const force = options?.force === true ? ["--force"] : [];
          const done = await git(["worktree", "remove", ...force, target]);
          if (done.code === 0) return;
          if (options?.force !== true) throw new Fault(done.stderr.trim());
          fs.rmSync(target, { recursive: true, force: true });
          const pruned = await git(["worktree", "prune"]);
          if (pruned.code !== 0) throw new Fault((done.stderr + pruned.stderr).trim());
        },
      },
    };
  },
});
