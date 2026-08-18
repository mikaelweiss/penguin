import { adapter, type CommandResult, type ShellOptions } from "penguin";
import { z } from "zod";

const Ready = z.union([z.enum(["done", "skip"]), z.string()]);

const ISSUE_FIELDS = "number,title,body,state,url";
const PR_FIELDS = "number,title,body,state,isDraft,headRefOid,url";
const WATCHED_FIELDS = "state,isDraft,body,headRefOid,comments";
const REQUESTED_FIELDS = "number,title,url";
const REQUESTED_LIMIT = 100;
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

type Requested = {
  number: number;
  title: string;
  url: string;
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

/** What a person fixes outside penguin, and the line that says how. */
function blocking(done: CommandResult): string | undefined {
  if (done.code === 127) {
    return "gh is not installed. Install it from https://cli.github.com, then reply done.";
  }
  if (/not logged in to|gh auth login/.test(done.stderr)) {
    return "gh is signed out. Run `gh auth login`, then reply done.";
  }
  if (/no git remotes found/.test(done.stderr)) {
    return "This checkout has no git remote. Run `git remote add origin <url>`, then reply done.";
  }
  if (/you must first push the current branch/.test(done.stderr)) {
    return "The branch is not on the remote. Run `git push -u origin HEAD`, then reply done.";
  }
  return undefined;
}

export default adapter({
  role: "github",
  name: "gh",
  description: "GitHub issues and pull requests through the gh CLI, under your own login",
  build: (host) => {
    /** A gh call. What only a person can fix waits at a gate, then the call runs again. */
    async function gh(cmd: string, options?: ShellOptions): Promise<CommandResult> {
      for (;;) {
        const done = await host.shell(cmd, options);
        const fix = blocking(done);
        if (fix === undefined) return done;
        if ((await host.gate(fix, Ready)) === "skip") return done;
      }
    }

    return {
      issue: {
        async get(ref: string): Promise<{ ok: boolean; issue: Issue | null; reason: string }> {
          const done = await gh(`gh issue view ${quoted(ref)} --json ${ISSUE_FIELDS}`);
          if (done.code !== 0) return { ok: false, issue: null, reason: done.stderr.trim() };
          return { ok: true, issue: JSON.parse(done.stdout) as Issue, reason: "" };
        },
        async comments(ref: string): Promise<{ ok: boolean; comments: Comment[]; reason: string }> {
          const done = await gh(`gh issue view ${quoted(ref)} --json comments`);
          if (done.code !== 0) return { ok: false, comments: [], reason: done.stderr.trim() };
          return { ok: true, comments: commentsOf(done.stdout), reason: "" };
        },
      },
      pr: {
        async get(pr: string): Promise<{ ok: boolean; pr: Pr | null; reason: string }> {
          const done = await gh(`gh pr view ${quoted(pr)} --json ${PR_FIELDS}`);
          if (done.code !== 0) return { ok: false, pr: null, reason: done.stderr.trim() };
          return { ok: true, pr: JSON.parse(done.stdout) as Pr, reason: "" };
        },
        async comments(pr: string): Promise<{ ok: boolean; comments: Comment[]; reason: string }> {
          const done = await gh(`gh pr view ${quoted(pr)} --json comments`);
          if (done.code !== 0) return { ok: false, comments: [], reason: done.stderr.trim() };
          return { ok: true, comments: commentsOf(done.stdout), reason: "" };
        },
        /** The branch's pull request. One that is open already is the answer, not a failure. */
        async create(options?: {
          cwd?: string;
        }): Promise<{ ok: boolean; url: string; existed: boolean; reason: string }> {
          const done = await gh("gh pr create --fill", { cwd: options?.cwd });
          if (done.code === 0) {
            return { ok: true, url: done.stdout.trim(), existed: false, reason: "" };
          }
          const reason = done.stderr.trim();
          if (!/already exists/.test(done.stderr)) {
            return { ok: false, url: "", existed: false, reason };
          }
          const open = await gh("gh pr view --json url", { cwd: options?.cwd });
          if (open.code !== 0) return { ok: false, url: "", existed: false, reason };
          const url = String((JSON.parse(open.stdout) as { url?: unknown }).url ?? "");
          if (url === "") return { ok: false, url: "", existed: false, reason };
          return { ok: true, url, existed: true, reason: "" };
        },
        async diff(pr: string): Promise<{ ok: boolean; diff: string; reason: string }> {
          const done = await gh(`gh pr diff ${quoted(pr)}`);
          return { ok: done.code === 0, diff: done.stdout, reason: done.stderr.trim() };
        },
        async comment(
          pr: string,
          options: { body: string } | { bodyFile: string },
        ): Promise<{ ok: boolean; reason: string }> {
          const done =
            "body" in options
              ? await gh(`gh pr comment ${quoted(pr)} --body-file -`, {
                  stdin: options.body,
                })
              : await gh(
                  `gh pr comment ${quoted(pr)} --body-file ${quoted(options.bodyFile)}`,
                );
          return { ok: done.code === 0, reason: done.stderr.trim() };
        },
        async approve(pr: string): Promise<{ ok: boolean; reason: string }> {
          const done = await gh(`gh pr review ${quoted(pr)} --approve`);
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
                    const done = await gh(`gh pr view ${quoted(pr)} --json ${WATCHED_FIELDS}`);
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
        async requested(reviewer: string): Promise<{ next(): Promise<Requested> }> {
          const search = `review-requested:${reviewer} draft:false`;
          let last: number[] | undefined;
          let failing = false;
          const queue: Requested[] = [];
          return {
            next: () =>
              host.wait(`watching the review requests for ${reviewer}`, async () => {
                for (;;) {
                  const ready = queue.shift();
                  if (ready !== undefined) return ready;
                  try {
                    const done = await gh(
                      `gh pr list --search ${quoted(search)} --state open --limit ${REQUESTED_LIMIT} --json ${REQUESTED_FIELDS}`,
                    );
                    if (done.code !== 0) throw new Error(done.stderr.trim());
                    const open = JSON.parse(done.stdout) as Requested[];
                    const before = last ?? [];
                    queue.push(...open.filter((pr) => !before.includes(pr.number)));
                    last = open.map((pr) => pr.number);
                    failing = false;
                  } catch (error) {
                    if (!failing) {
                      host.emit({
                        type: "event",
                        level: "warn",
                        message: `watching the review requests for ${reviewer} failed: ${error instanceof Error ? error.message : String(error)}`,
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
    };
  },
});
