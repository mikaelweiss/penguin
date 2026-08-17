import path from "node:path";
import { adapter } from "penguin";

function quoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export default adapter({
  role: "vcs",
  name: "git",
  description: "git working copies: staging, commits, and worktrees",
  build: (host) => ({
    async stageAll(options?: { cwd?: string }): Promise<{ ok: boolean; reason: string }> {
      const done = await host.shell("git add -A", { cwd: options?.cwd });
      return { ok: done.code === 0, reason: done.stderr.trim() };
    },
    async commit(
      message: string,
      options?: { cwd?: string },
    ): Promise<{ ok: boolean; reason: string }> {
      const done = await host.shell(`git commit -m ${quoted(message)}`, { cwd: options?.cwd });
      return { ok: done.code === 0, reason: (done.stdout + done.stderr).trim() };
    },
    async pull(ref: string, options?: { cwd?: string }): Promise<{ ok: boolean; reason: string }> {
      const done = await host.shell(
        `git fetch origin ${quoted(ref)} && git reset --hard FETCH_HEAD`,
        { cwd: options?.cwd },
      );
      return { ok: done.code === 0, reason: done.stderr.trim() };
    },
    worktree: {
      async add(
        name: string,
        options?: { ref?: string },
      ): Promise<{ ok: boolean; path: string; reason: string }> {
        const target = path.resolve(host.cwd, "..", name);
        if (options?.ref !== undefined) {
          const fetched = await host.shell(`git fetch origin ${quoted(options.ref)}`);
          if (fetched.code !== 0) return { ok: false, path: target, reason: fetched.stderr.trim() };
          const done = await host.shell(`git worktree add --detach ${quoted(target)} FETCH_HEAD`);
          return { ok: done.code === 0, path: target, reason: done.stderr.trim() };
        }
        const done = await host.shell(`git worktree add ${quoted(target)}`);
        return { ok: done.code === 0, path: target, reason: done.stderr.trim() };
      },
      async remove(target: string): Promise<{ ok: boolean; reason: string }> {
        const done = await host.shell(`git worktree remove ${quoted(target)}`);
        return { ok: done.code === 0, reason: done.stderr.trim() };
      },
    },
  }),
});
