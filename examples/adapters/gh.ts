import { adapter } from "wa";

function quoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export default adapter({
  role: "github",
  name: "gh",
  description: "GitHub pull requests through the gh CLI, under your own login",
  build: (host) => ({
    pr: {
      async create(options?: { cwd?: string }): Promise<{ ok: boolean; url: string; reason: string }> {
        const done = await host.shell("gh pr create --fill", { cwd: options?.cwd });
        return { ok: done.code === 0, url: done.stdout.trim(), reason: done.stderr.trim() };
      },
      async diff(pr: string): Promise<{ ok: boolean; diff: string; reason: string }> {
        const done = await host.shell(`gh pr diff ${quoted(pr)}`);
        return { ok: done.code === 0, diff: done.stdout, reason: done.stderr.trim() };
      },
      async comment(
        pr: string,
        options: { bodyFile: string },
      ): Promise<{ ok: boolean; reason: string }> {
        const done = await host.shell(
          `gh pr comment ${quoted(pr)} --body-file ${quoted(options.bodyFile)}`,
        );
        return { ok: done.code === 0, reason: done.stderr.trim() };
      },
    },
  }),
});
