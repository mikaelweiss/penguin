import { adapter } from "penguin";

const ISSUE_FIELDS = "number,title,body,state,url";
const PR_FIELDS = "number,title,body,state,isDraft,headRefOid,url";
const WATCHED_FIELDS = "state,isDraft,body,headRefOid,comments";
const POLL_MS = 30_000;

type Issue = {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
};

type Pr = {
  number: number;
  title: string;
  body: string;
  state: string;
  isDraft: boolean;
  headRefOid: string;
  url: string;
};

type Comment = {
  author: string;
  at: string;
  body: string;
};

type Written = { author?: { login?: string }; createdAt?: string; body?: string };

type Watched = {
  state: string;
  isDraft: boolean;
  body: string;
  headRefOid: string;
  comments?: Written[];
};

type Change =
  | { kind: "closed"; state: string }
  | { kind: "draft" }
  | { kind: "ready" }
  | { kind: "commits" }
  | { kind: "description"; body: string }
  | { kind: "comments"; comments: Comment[] };

function quoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function written(one: Written): Comment {
  return {
    author: one.author?.login ?? "",
    at: one.createdAt ?? "",
    body: (one.body ?? "").trim(),
  };
}

function commentsOf(stdout: string): Comment[] {
  const parsed = JSON.parse(stdout) as { comments?: Written[] };
  return (parsed.comments ?? []).map(written);
}

function changedBetween(last: Watched, snap: Watched): Change[] {
  const found: Change[] = [];
  if (snap.state !== last.state && snap.state !== "OPEN") {
    found.push({ kind: "closed", state: snap.state });
  }
  if (snap.isDraft && !last.isDraft) found.push({ kind: "draft" });
  if (!snap.isDraft && last.isDraft) found.push({ kind: "ready" });
  if (snap.headRefOid !== last.headRefOid) found.push({ kind: "commits" });
  if (snap.body !== last.body) found.push({ kind: "description", body: snap.body });
  const fresh = (snap.comments ?? []).slice((last.comments ?? []).length);
  if (fresh.length > 0) found.push({ kind: "comments", comments: fresh.map(written) });
  return found;
}

function rested(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default adapter({
  role: "github",
  name: "gh",
  description: "GitHub issues and pull requests through the gh CLI, under your own login",
  build: (host) => ({
    issue: {
      async get(ref: string): Promise<{ ok: boolean; issue: Issue | null; reason: string }> {
        const done = await host.shell(`gh issue view ${quoted(ref)} --json ${ISSUE_FIELDS}`);
        if (done.code !== 0) return { ok: false, issue: null, reason: done.stderr.trim() };
        return { ok: true, issue: JSON.parse(done.stdout) as Issue, reason: "" };
      },
      async comments(ref: string): Promise<{ ok: boolean; comments: Comment[]; reason: string }> {
        const done = await host.shell(`gh issue view ${quoted(ref)} --json comments`);
        if (done.code !== 0) return { ok: false, comments: [], reason: done.stderr.trim() };
        return { ok: true, comments: commentsOf(done.stdout), reason: "" };
      },
    },
    pr: {
      async get(pr: string): Promise<{ ok: boolean; pr: Pr | null; reason: string }> {
        const done = await host.shell(`gh pr view ${quoted(pr)} --json ${PR_FIELDS}`);
        if (done.code !== 0) return { ok: false, pr: null, reason: done.stderr.trim() };
        return { ok: true, pr: JSON.parse(done.stdout) as Pr, reason: "" };
      },
      async comments(pr: string): Promise<{ ok: boolean; comments: Comment[]; reason: string }> {
        const done = await host.shell(`gh pr view ${quoted(pr)} --json comments`);
        if (done.code !== 0) return { ok: false, comments: [], reason: done.stderr.trim() };
        return { ok: true, comments: commentsOf(done.stdout), reason: "" };
      },
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
        options: { body: string } | { bodyFile: string },
      ): Promise<{ ok: boolean; reason: string }> {
        const done =
          "body" in options
            ? await host.shell(`gh pr comment ${quoted(pr)} --body-file -`, {
                stdin: options.body,
              })
            : await host.shell(
                `gh pr comment ${quoted(pr)} --body-file ${quoted(options.bodyFile)}`,
              );
        return { ok: done.code === 0, reason: done.stderr.trim() };
      },
      async approve(pr: string): Promise<{ ok: boolean; reason: string }> {
        const done = await host.shell(`gh pr review ${quoted(pr)} --approve`);
        return { ok: done.code === 0, reason: done.stderr.trim() };
      },
      async changes(pr: string): Promise<{ next(): Promise<Change> }> {
        let last: Watched | undefined;
        let failing = false;
        const queue: Change[] = [];
        return {
          next: () =>
            host.wait(`watching PR ${pr}`, async () => {
              for (;;) {
                const ready = queue.shift();
                if (ready !== undefined) return ready;
                try {
                  const done = await host.shell(`gh pr view ${quoted(pr)} --json ${WATCHED_FIELDS}`);
                  if (done.code !== 0) throw new Error(done.stderr.trim());
                  const snap = JSON.parse(done.stdout) as Watched;
                  if (last !== undefined) queue.push(...changedBetween(last, snap));
                  last = snap;
                  failing = false;
                } catch (error) {
                  if (!failing) {
                    host.emit({
                      type: "event",
                      level: "warn",
                      message: `watching PR ${pr} failed: ${error instanceof Error ? error.message : String(error)}`,
                    });
                  }
                  failing = true;
                }
                if (queue.length === 0) await rested(POLL_MS);
              }
            }),
        };
      },
    },
  }),
});
