import fs from "node:fs";
import path from "node:path";
import { adapter } from "penguin";

function quoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

type Done = { ok: boolean; reason: string };
type Rebase = Done & { conflicted: boolean; files: string[] };

export default adapter({
  role: "vcs",
  name: "git",
  description: "git working copies: staging, commits, worktrees, and rebasing a branch onto another",
  build: (host) => {
    async function unmerged(cwd: string | undefined): Promise<string[]> {
      const done = await host.shell("git diff --name-only --diff-filter=U", { cwd });
      const text = done.stdout.trim();
      return text === "" ? [] : text.split("\n");
    }

    async function rebased(
      command: string,
      cwd: string | undefined,
    ): Promise<Rebase> {
      const done = await host.shell(command, { cwd });
      const files = done.code === 0 ? [] : await unmerged(cwd);
      return {
        ok: done.code === 0,
        conflicted: files.length > 0,
        files,
        reason: (done.stdout + done.stderr).trim(),
      };
    }

    return {
      async stageAll(options?: { cwd?: string }): Promise<Done> {
        const done = await host.shell("git add -A", { cwd: options?.cwd });
        return { ok: done.code === 0, reason: done.stderr.trim() };
      },
      async commit(message: string, options?: { cwd?: string }): Promise<Done> {
        const done = await host.shell(`git commit -m ${quoted(message)}`, { cwd: options?.cwd });
        return { ok: done.code === 0, reason: (done.stdout + done.stderr).trim() };
      },
      async dirty(options?: { cwd?: string }): Promise<Done & { dirty: boolean }> {
        const done = await host.shell("git status --porcelain", { cwd: options?.cwd });
        return {
          ok: done.code === 0,
          dirty: done.stdout.trim() !== "",
          reason: done.stderr.trim(),
        };
      },
      async head(options?: { cwd?: string }): Promise<Done & { branch: string; sha: string }> {
        const done = await host.shell(
          "git rev-parse --abbrev-ref HEAD && git rev-parse --short HEAD",
          { cwd: options?.cwd },
        );
        const [branch = "", sha = ""] = done.stdout.trim().split("\n");
        return {
          ok: done.code === 0,
          branch: branch.trim(),
          sha: sha.trim(),
          reason: done.stderr.trim(),
        };
      },
      async fetch(ref: string, options?: { cwd?: string }): Promise<Done> {
        const done = await host.shell(`git fetch origin ${quoted(ref)}`, { cwd: options?.cwd });
        return { ok: done.code === 0, reason: done.stderr.trim() };
      },
      async pull(ref: string, options?: { cwd?: string }): Promise<Done> {
        const done = await host.shell(
          `git fetch origin ${quoted(ref)} && git reset --hard FETCH_HEAD`,
          { cwd: options?.cwd },
        );
        return { ok: done.code === 0, reason: done.stderr.trim() };
      },
      async merge(
        branch: string,
        options?: { cwd?: string; ffOnly?: boolean },
      ): Promise<Done> {
        const how = options?.ffOnly === true ? " --ff-only" : "";
        const done = await host.shell(`git merge${how} ${quoted(branch)}`, { cwd: options?.cwd });
        return { ok: done.code === 0, reason: (done.stdout + done.stderr).trim() };
      },
      rebase: {
        async onto(ref: string, options?: { cwd?: string }): Promise<Rebase> {
          return rebased(`git rebase ${quoted(ref)}`, options?.cwd);
        },
        async continue(options?: { cwd?: string }): Promise<Rebase> {
          return rebased("GIT_EDITOR=true git rebase --continue", options?.cwd);
        },
        async abort(options?: { cwd?: string }): Promise<Done> {
          const done = await host.shell("git rebase --abort", { cwd: options?.cwd });
          return { ok: done.code === 0, reason: done.stderr.trim() };
        },
      },
      worktree: {
        async add(
          name: string,
          options?: { ref?: string },
        ): Promise<{ ok: boolean; path: string; exists: boolean; reason: string }> {
          const target = path.resolve(host.cwd, "..", name);
          if (fs.existsSync(target))
            return { ok: false, path: target, exists: true, reason: `${target} already exists` };
          if (options?.ref !== undefined) {
            const fetched = await host.shell(`git fetch origin ${quoted(options.ref)}`);
            if (fetched.code !== 0)
              return { ok: false, path: target, exists: false, reason: fetched.stderr.trim() };
            const done = await host.shell(`git worktree add --detach ${quoted(target)} FETCH_HEAD`);
            return {
              ok: done.code === 0,
              path: target,
              exists: false,
              reason: done.stderr.trim(),
            };
          }
          const done = await host.shell(`git worktree add ${quoted(target)}`);
          return { ok: done.code === 0, path: target, exists: false, reason: done.stderr.trim() };
        },
        async remove(target: string, options?: { force?: boolean }): Promise<Done> {
          const force = options?.force === true ? " --force" : "";
          const done = await host.shell(`git worktree remove${force} ${quoted(target)}`);
          if (done.code === 0) return { ok: true, reason: "" };
          if (options?.force !== true) return { ok: false, reason: done.stderr.trim() };
          const pruned = await host.shell(`rm -rf ${quoted(target)} && git worktree prune`);
          return { ok: pruned.code === 0, reason: (done.stderr + pruned.stderr).trim() };
        },
      },
    };
  },
});
