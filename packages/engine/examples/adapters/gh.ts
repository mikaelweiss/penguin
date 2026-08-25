import { adapter, messageOf, type CommandResult } from "penguin";

const ISSUE_FIELDS = "number,title,body,state,url";
const PR_FIELDS = "number,title,body,state,isDraft,headRefOid,url";
const WATCHED_FIELDS = "state,isDraft,body,headRefOid,url,comments,reviews";
const QUEUE_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){isInMergeQueue}}}";
const QUEUE_PATH = ".data.repository.pullRequest.isInMergeQueue";
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
  isInMergeQueue: boolean;
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

type Judged = { author?: { login?: string }; state?: string; body?: string };

type Watched = {
  state: string;
  isDraft: boolean;
  body: string;
  headRefOid: string;
  url: string;
  isInMergeQueue: boolean;
  comments?: Written[];
  reviews?: Judged[];
};

type Place = { owner: string; repo: string; number: string };

type Change =
  | { kind: "closed"; state: string }
  | { kind: "approved" }
  | { kind: "reviewed"; author: string; state: string; body: string }
  | { kind: "draft" }
  | { kind: "ready" }
  | { kind: "queued" }
  | { kind: "dequeued" }
  | { kind: "commits" }
  | { kind: "description"; body: string }
  | { kind: "comments"; comments: Comment[] };

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

function placeOf(url: string): Place | undefined {
  const found = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (found === null) return undefined;
  return { owner: found[1] ?? "", repo: found[2] ?? "", number: found[3] ?? "" };
}

function queueRead(place: Place): string[] {
  return [
    "api",
    "graphql",
    "-f",
    `query=${QUEUE_QUERY}`,
    "-f",
    `owner=${place.owner}`,
    "-f",
    `name=${place.repo}`,
    "-F",
    `number=${place.number}`,
    "-q",
    QUEUE_PATH,
  ];
}

/** Yours and theirs part ways here: your approval ends a review, theirs is feedback to answer. */
export function changedBetween(last: Watched, snap: Watched, me: string): Change[] {
  const found: Change[] = [];
  if (snap.state !== last.state && snap.state !== "OPEN") {
    found.push({ kind: "closed", state: snap.state });
  }
  const signed = (snap.reviews ?? []).slice((last.reviews ?? []).length);
  if (signed.some((one) => one.state === "APPROVED" && one.author?.login === me)) {
    found.push({ kind: "approved" });
  }
  for (const one of signed) {
    if (one.author?.login === me) continue;
    found.push({
      kind: "reviewed",
      author: one.author?.login ?? "",
      state: one.state ?? "",
      body: (one.body ?? "").trim(),
    });
  }
  if (snap.isDraft && !last.isDraft) found.push({ kind: "draft" });
  if (!snap.isDraft && last.isDraft) found.push({ kind: "ready" });
  if (snap.isInMergeQueue && !last.isInMergeQueue) found.push({ kind: "queued" });
  if (!snap.isInMergeQueue && last.isInMergeQueue) found.push({ kind: "dequeued" });
  if (snap.headRefOid !== last.headRefOid) found.push({ kind: "commits" });
  if (snap.body !== last.body) found.push({ kind: "description", body: snap.body });
  // What the run itself writes is not news to it.
  const fresh = (snap.comments ?? [])
    .slice((last.comments ?? []).length)
    .filter((one) => one.author?.login !== me);
  if (fresh.length > 0) found.push({ kind: "comments", comments: fresh.map(written) });
  return found;
}

function rested(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What a person fixes outside penguin rides in the reason, with the line that says how. */
function reasonOf(done: CommandResult): string {
  if (done.code === 127) {
    return "gh is not installed. Install it from https://cli.github.com and run again.";
  }
  if (/not logged in to|gh auth login/.test(done.stderr)) {
    return "gh is signed out. Run `gh auth login` and run again.";
  }
  if (/no git remotes found/.test(done.stderr)) {
    return "This checkout has no git remote. Run `git remote add origin <url>` and run again.";
  }
  return done.stderr.trim();
}

export default adapter({
  role: "github",
  name: "gh",
  description: "GitHub issues and pull requests through the gh CLI, under your own login",
  build: (host) => {
    async function gh(
      args: string[],
      options?: { cwd?: string; stdin?: string },
    ): Promise<CommandResult> {
      try {
        return await host.exec(["gh", ...args], options);
      } catch (error) {
        return { code: 127, stdout: "", stderr: messageOf(error) };
      }
    }

    return {
      issue: {
        async get(ref: string): Promise<{ ok: boolean; issue: Issue | null; reason: string }> {
          const done = await gh(["issue", "view", ref, "--json", ISSUE_FIELDS]);
          if (done.code !== 0) return { ok: false, issue: null, reason: reasonOf(done) };
          return { ok: true, issue: JSON.parse(done.stdout) as Issue, reason: "" };
        },
        async comments(ref: string): Promise<{ ok: boolean; comments: Comment[]; reason: string }> {
          const done = await gh(["issue", "view", ref, "--json", "comments"]);
          if (done.code !== 0) return { ok: false, comments: [], reason: reasonOf(done) };
          return { ok: true, comments: commentsOf(done.stdout), reason: "" };
        },
      },
      pr: {
        async get(pr: string): Promise<{ ok: boolean; pr: Pr | null; reason: string }> {
          const done = await gh(["pr", "view", pr, "--json", PR_FIELDS]);
          if (done.code !== 0) return { ok: false, pr: null, reason: reasonOf(done) };
          const found = JSON.parse(done.stdout) as Pr;
          const place = placeOf(found.url);
          if (place === undefined)
            return { ok: false, pr: null, reason: `the PR url did not read: ${found.url}` };
          const asked = await gh(queueRead(place));
          if (asked.code !== 0) return { ok: false, pr: null, reason: reasonOf(asked) };
          found.isInMergeQueue = asked.stdout.trim() === "true";
          return { ok: true, pr: found, reason: "" };
        },
        async comments(pr: string): Promise<{ ok: boolean; comments: Comment[]; reason: string }> {
          const done = await gh(["pr", "view", pr, "--json", "comments"]);
          if (done.code !== 0) return { ok: false, comments: [], reason: reasonOf(done) };
          return { ok: true, comments: commentsOf(done.stdout), reason: "" };
        },
        /** The branch's pull request. One that is open already is the answer, not a failure. */
        async create(options?: {
          cwd?: string;
          head?: string;
          base?: string;
          title?: string;
          body?: string;
        }): Promise<{ ok: boolean; url: string; existed: boolean; reason: string }> {
          // A stack names its own head: the tree sits on the top branch while every PR below it opens.
          const where: string[] = [];
          if (options?.head !== undefined) where.push("--head", options.head);
          if (options?.base !== undefined) where.push("--base", options.base);
          const done =
            options?.title === undefined
              ? await gh(["pr", "create", "--fill", ...where], { cwd: options?.cwd })
              : await gh(["pr", "create", "--title", options.title, "--body-file", "-", ...where], {
                  cwd: options?.cwd,
                  stdin: options.body ?? "",
                });
          if (done.code === 0) {
            return { ok: true, url: done.stdout.trim(), existed: false, reason: "" };
          }
          const reason = reasonOf(done);
          if (!/already exists/.test(done.stderr)) {
            return { ok: false, url: "", existed: false, reason };
          }
          const which = options?.head === undefined ? [] : [options.head];
          const open = await gh(["pr", "view", ...which, "--json", "url"], { cwd: options?.cwd });
          if (open.code !== 0) return { ok: false, url: "", existed: false, reason };
          const url = String((JSON.parse(open.stdout) as { url?: unknown }).url ?? "");
          if (url === "") return { ok: false, url: "", existed: false, reason };
          return { ok: true, url, existed: true, reason: "" };
        },
        async diff(pr: string): Promise<{ ok: boolean; diff: string; reason: string }> {
          const done = await gh(["pr", "diff", pr]);
          return { ok: done.code === 0, diff: done.stdout, reason: done.code === 0 ? "" : reasonOf(done) };
        },
        async comment(
          pr: string,
          options: { body: string } | { bodyFile: string },
        ): Promise<{ ok: boolean; reason: string }> {
          const done =
            "body" in options
              ? await gh(["pr", "comment", pr, "--body-file", "-"], { stdin: options.body })
              : await gh(["pr", "comment", pr, "--body-file", options.bodyFile]);
          return { ok: done.code === 0, reason: done.code === 0 ? "" : reasonOf(done) };
        },
        async approve(pr: string): Promise<{ ok: boolean; reason: string }> {
          const done = await gh(["pr", "review", pr, "--approve"]);
          return { ok: done.code === 0, reason: done.code === 0 ? "" : reasonOf(done) };
        },
        /** A handle, not a snapshot, so the trace never replays a poll. A failed poll retries quietly. */
        changes(pr: string): { next(): Promise<Change> } {
          let last: Watched | undefined;
          let place: Place | undefined;
          let me: string | undefined;
          const queue: Change[] = [];
          // The watch reports your approval alone, so it needs the login gh signs the review with.
          const login = async (): Promise<string> => {
            if (me !== undefined) return me;
            const who = await gh(["api", "user", "-q", ".login"]);
            if (who.code !== 0) throw new Error(reasonOf(who));
            const found = who.stdout.trim();
            if (found === "") throw new Error("gh named no login for you");
            me = found;
            return found;
          };
          return {
            async next(): Promise<Change> {
              for (;;) {
                const ready = queue.shift();
                if (ready !== undefined) return ready;
                try {
                  const yours = await login();
                  const done = await gh(["pr", "view", pr, "--json", WATCHED_FIELDS]);
                  if (done.code !== 0) throw new Error(reasonOf(done));
                  const snap = JSON.parse(done.stdout) as Watched;
                  place = place ?? placeOf(snap.url);
                  if (place === undefined) throw new Error(`the PR url did not read: ${snap.url}`);
                  const asked = await gh(queueRead(place));
                  if (asked.code !== 0) throw new Error(reasonOf(asked));
                  snap.isInMergeQueue = asked.stdout.trim() === "true";
                  if (last !== undefined) queue.push(...changedBetween(last, snap, yours));
                  last = snap;
                } catch {
                  // The next poll tries again. A watch has nowhere to report a passing failure.
                }
                if (queue.length === 0) await rested(POLL_MS);
              }
            },
          };
        },
        /** A handle, not a snapshot, so the trace never replays a poll. A failed poll retries quietly. */
        requested(reviewer: string): { next(): Promise<Requested> } {
          const search = `review-requested:${reviewer} draft:false`;
          let last: number[] | undefined;
          const queue: Requested[] = [];
          return {
            async next(): Promise<Requested> {
              for (;;) {
                const ready = queue.shift();
                if (ready !== undefined) return ready;
                try {
                  const done = await gh([
                    "pr",
                    "list",
                    "--search",
                    search,
                    "--state",
                    "open",
                    "--limit",
                    String(REQUESTED_LIMIT),
                    "--json",
                    REQUESTED_FIELDS,
                  ]);
                  if (done.code !== 0) throw new Error(reasonOf(done));
                  const open = JSON.parse(done.stdout) as Requested[];
                  const before = last ?? [];
                  queue.push(...open.filter((pr) => !before.includes(pr.number)));
                  last = open.map((pr) => pr.number);
                } catch {
                  // The next poll tries again. A watch has nowhere to report a passing failure.
                }
                if (queue.length === 0) await rested(POLL_MS);
              }
            },
          };
        },
      },
    };
  },
});
