import { adapter } from "penguin";

const FIELDS = "number,title,body,state,url";

type Issue = {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
};

function quoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export default adapter({
  role: "github",
  name: "gh",
  description: "GitHub issues and pull requests through the gh CLI, under your own login",
  build: (host) => ({
    issue: {
      async get(ref: string): Promise<{ ok: boolean; issue: Issue | null; reason: string }> {
        const done = await host.shell(`gh issue view ${quoted(ref)} --json ${FIELDS}`);
        if (done.code !== 0) return { ok: false, issue: null, reason: done.stderr.trim() };
        return { ok: true, issue: JSON.parse(done.stdout) as Issue, reason: "" };
      },
    },
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
