import fs from "node:fs";
import path from "node:path";
import { adapter, type CommandResult } from "penguin";

type Done = { ok: boolean; reason: string };
type Rebase = Done & { conflicted: boolean; files: string[] };

export default adapter({
  role: "vcs",
  name: "git",
  description:
    "git working copies: staging, commits, pushes, worktrees, and rebasing a branch onto another",
  build: (host) => {
    const git = (args: string[], cwd?: string): Promise<CommandResult> =>
      host.exec(["git", ...args], { cwd });

    async function unmerged(cwd: string | undefined): Promise<string[]> {
      const done = await git(["diff", "--name-only", "--diff-filter=U"], cwd);
      const text = done.stdout.trim();
      return text === "" ? [] : text.split("\n");
    }

    async function rebased(
      running: Promise<CommandResult>,
      cwd: string | undefined,
    ): Promise<Rebase> {
      const done = await running;
      const files = done.code === 0 ? [] : await unmerged(cwd);
      return {
        ok: done.code === 0,
        conflicted: files.length > 0,
        files,
        reason: (done.stdout + done.stderr).trim(),
      };
    }

    return {
      async stage(files: string[], options?: { cwd?: string }): Promise<Done> {
        const done = await git(["add", "--", ...files], options?.cwd);
        return { ok: done.code === 0, reason: done.stderr.trim() };
      },
      async commit(message: string, options?: { cwd?: string }): Promise<Done> {
        const done = await git(["commit", "-m", message], options?.cwd);
        return { ok: done.code === 0, reason: (done.stdout + done.stderr).trim() };
      },
      async dirty(options?: { cwd?: string }): Promise<Done & { dirty: boolean }> {
        const done = await git(["status", "--porcelain"], options?.cwd);
        return {
          ok: done.code === 0,
          dirty: done.stdout.trim() !== "",
          reason: done.stderr.trim(),
        };
      },
      async head(
        options?: { cwd?: string },
      ): Promise<Done & { branch: string; sha: string; detached: boolean }> {
        const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], options?.cwd);
        const sha = await git(["rev-parse", "--short", "HEAD"], options?.cwd);
        const name = branch.stdout.trim();
        return {
          ok: branch.code === 0 && sha.code === 0,
          branch: name,
          sha: sha.stdout.trim(),
          detached: name === "HEAD",
          reason: (branch.stderr + sha.stderr).trim(),
        };
      },
      /** The branch origin calls its default. Unset origin/HEAD answers not ok, never a guess. */
      async defaultBranch(options?: { cwd?: string }): Promise<Done & { branch: string }> {
        const done = await git(
          ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
          options?.cwd,
        );
        const branch = done.stdout.trim().replace(/^origin\//, "");
        return { ok: done.code === 0 && branch !== "", branch, reason: done.stderr.trim() };
      },
      async fetch(ref: string, options?: { cwd?: string }): Promise<Done> {
        const done = await git(["fetch", "origin", ref], options?.cwd);
        return { ok: done.code === 0, reason: done.stderr.trim() };
      },
      /** Fast-forwards onto the fetched ref. Diverged histories answer not ok, nothing is discarded. */
      async pull(ref: string, options?: { cwd?: string }): Promise<Done> {
        const fetched = await git(["fetch", "origin", ref], options?.cwd);
        if (fetched.code !== 0) return { ok: false, reason: fetched.stderr.trim() };
        const merged = await git(["merge", "--ff-only", "FETCH_HEAD"], options?.cwd);
        return { ok: merged.code === 0, reason: (merged.stdout + merged.stderr).trim() };
      },
      /** Discards local commits and changes to match the ref. The name is the warning. */
      async resetHard(ref: string, options?: { cwd?: string }): Promise<Done> {
        const done = await git(["reset", "--hard", ref], options?.cwd);
        return { ok: done.code === 0, reason: (done.stdout + done.stderr).trim() };
      },
      /** `force` uses --force-with-lease, so a rebased branch pushes without clobbering unseen work. */
      async push(branch: string, options?: { cwd?: string; force?: boolean }): Promise<Done> {
        const how = options?.force === true ? ["--force-with-lease"] : [];
        const done = await git(["push", "-u", ...how, "origin", branch], options?.cwd);
        return { ok: done.code === 0, reason: (done.stdout + done.stderr).trim() };
      },
      async merge(
        branch: string,
        options?: { cwd?: string; ffOnly?: boolean },
      ): Promise<Done> {
        const how = options?.ffOnly === true ? ["--ff-only"] : [];
        const done = await git(["merge", ...how, branch], options?.cwd);
        return { ok: done.code === 0, reason: (done.stdout + done.stderr).trim() };
      },
      branch: {
        async create(name: string, options?: { cwd?: string }): Promise<Done> {
          const done = await git(["checkout", "-b", name], options?.cwd);
          return { ok: done.code === 0, reason: (done.stdout + done.stderr).trim() };
        },
      },
      rebase: {
        onto(ref: string, options?: { cwd?: string }): Promise<Rebase> {
          return rebased(git(["rebase", ref], options?.cwd), options?.cwd);
        },
        continue(options?: { cwd?: string }): Promise<Rebase> {
          // GIT_EDITOR stops the continue from opening an editor. The string is constant, so shell is safe.
          return rebased(
            host.shell("GIT_EDITOR=true git rebase --continue", { cwd: options?.cwd }),
            options?.cwd,
          );
        },
        async abort(options?: { cwd?: string }): Promise<Done> {
          const done = await git(["rebase", "--abort"], options?.cwd);
          return { ok: done.code === 0, reason: done.stderr.trim() };
        },
      },
      worktree: {
        async add(
          name: string,
          options?: { ref?: string; from?: string },
        ): Promise<{ ok: boolean; path: string; exists: boolean; reason: string }> {
          // The note tells frontends where the run's work moved, so the terminal and diff follow.
          const moved = (dir: string): void => {
            fs.appendFileSync(
              path.join(host.run.dir, "run.jsonl"),
              `${JSON.stringify({ at: new Date().toISOString(), dir })}\n`,
            );
          };
          const root = await git(["rev-parse", "--show-toplevel"]);
          const project = path.basename(root.stdout.trim() === "" ? host.cwd : root.stdout.trim());
          const base = host.config("worktrees") ?? path.join(host.home, "worktrees");
          const target = path.join(base, project, name);
          if (fs.existsSync(target))
            return { ok: false, path: target, exists: true, reason: `${target} already exists` };
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (options?.ref !== undefined) {
            const fetched = await git(["fetch", "origin", options.ref]);
            if (fetched.code !== 0)
              return { ok: false, path: target, exists: false, reason: fetched.stderr.trim() };
            const done = await git(["worktree", "add", "--detach", target, "FETCH_HEAD"]);
            if (done.code === 0) moved(target);
            return {
              ok: done.code === 0,
              path: target,
              exists: false,
              reason: done.stderr.trim(),
            };
          }
          // A local ref, so a worktree can start on a commit that has never reached the remote.
          const start = options?.from === undefined ? [] : [options.from];
          const done = await git(["worktree", "add", "-b", name, target, ...start]);
          if (done.code === 0) {
            moved(target);
            return { ok: true, path: target, exists: false, reason: "" };
          }
          // The branch already exists when a prior run made it; the worktree checks it out instead.
          if (/already exists/.test(done.stderr)) {
            const reused = await git(["worktree", "add", target, name]);
            if (reused.code === 0) moved(target);
            return {
              ok: reused.code === 0,
              path: target,
              exists: false,
              reason: reused.stderr.trim(),
            };
          }
          return { ok: false, path: target, exists: false, reason: done.stderr.trim() };
        },
        async remove(target: string, options?: { force?: boolean }): Promise<Done> {
          const force = options?.force === true ? ["--force"] : [];
          const done = await git(["worktree", "remove", ...force, target]);
          if (done.code === 0) return { ok: true, reason: "" };
          if (options?.force !== true) return { ok: false, reason: done.stderr.trim() };
          fs.rmSync(target, { recursive: true, force: true });
          const pruned = await git(["worktree", "prune"]);
          return { ok: pruned.code === 0, reason: (done.stderr + pruned.stderr).trim() };
        },
      },
    };
  },
});
