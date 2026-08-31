import fs from "node:fs";
import path from "node:path";
import { adapter, Fault, type CommandResult } from "penguin";

type Rebase = { conflicted: boolean; files: string[] };

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
      /** Commit hooks are what usually refuse one, and those are the agent's to clear. */
      async commit(message: string, options?: { cwd?: string }): Promise<void> {
        const done = await git(["commit", "-m", message], options?.cwd);
        if (done.code !== 0) throw new Fault(saidOf(done), { fix: "agent" });
      },
      async dirty(options?: { cwd?: string }): Promise<{ dirty: boolean }> {
        return { dirty: await dirtyOf(options?.cwd) };
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
       */
      async sync(
        branch: string,
        base: string,
        options?: { cwd?: string; local?: boolean },
      ): Promise<Sync> {
        const cwd = options?.cwd;
        const onto = options?.local === true ? base : `origin/${base}`;
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
          const landed = await rebased(git(["rebase", onto], cwd), cwd, onto);
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
        onto(ref: string, options?: { cwd?: string }): Promise<Rebase> {
          return rebased(git(["rebase", ref], options?.cwd), options?.cwd, ref);
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
          if (fs.existsSync(target)) return { path: target, existed: true };
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
