import { adapter, Fault, messageOf, type CommandResult } from "penguin";

const ISSUE_FIELDS = "number,title,body,state,url";
const PR_FIELDS = "number,title,body,state,isDraft,headRefOid,baseRefName,url";
const WATCHED_FIELDS = "state,isDraft,body,headRefOid,baseRefName,url,comments,reviews";
const QUEUE_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){isInMergeQueue}}}";
const QUEUE_PATH = ".data.repository.pullRequest.isInMergeQueue";
const THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:50){nodes{id isResolved path line comments(first:20){nodes{body author{login}}}}}}}}";
const THREADS_PATH = ".data.repository.pullRequest.reviewThreads.nodes";
const REPLY_QUERY =
  "mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}";
const OPENED_FIELDS = "number,baseRefName,url";
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
  baseRefName: string;
  url: string;
  isInMergeQueue: boolean;
};

type Comment = {
  author: string;
  at: string;
  body: string;
};

/** One review conversation on a line of the diff, in the order it was said. */
type Thread = {
  id: string;
  path: string;
  /** null when the line the thread sits on is gone from the diff. */
  line: number | null;
  comments: { author: string; body: string }[];
};

type Opened = {
  number: number;
  baseRefName: string;
  url: string;
};

type Requested = {
  number: number;
  title: string;
  url: string;
};

type Written = { author?: { login?: string }; createdAt?: string; body?: string };

type Reviewed = {
  id?: string;
  isResolved?: boolean;
  path?: string;
  line?: number | null;
  comments?: { nodes?: { body?: string; author?: { login?: string } }[] };
};

type Judged = { author?: { login?: string }; state?: string; body?: string };

type Watched = {
  state: string;
  isDraft: boolean;
  body: string;
  headRefOid: string;
  baseRefName: string;
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
  | { kind: "retargeted"; base: string }
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

/** Threads someone resolved are settled, so only the open ones come back. */
function openThreads(stdout: string): Thread[] {
  const nodes = JSON.parse(stdout) as Reviewed[];
  return nodes
    .filter((node) => node.isResolved !== true)
    .map((node) => ({
      id: node.id ?? "",
      path: node.path ?? "",
      line: node.line ?? null,
      comments: (node.comments?.nodes ?? []).map((one) => ({
        author: one.author?.login ?? "",
        body: (one.body ?? "").trim(),
      })),
    }));
}

function placeOf(url: string): Place | undefined {
  const found = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (found === null) return undefined;
  return { owner: found[1] ?? "", repo: found[2] ?? "", number: found[3] ?? "" };
}

function graphql(query: string, place: Place, path: string): string[] {
  return [
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${place.owner}`,
    "-f",
    `name=${place.repo}`,
    "-F",
    `number=${place.number}`,
    "-q",
    path,
  ];
}

function queueRead(place: Place): string[] {
  return graphql(QUEUE_QUERY, place, QUEUE_PATH);
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
  if (snap.baseRefName !== last.baseRefName) {
    found.push({ kind: "retargeted", base: snap.baseRefName });
  }
  if (snap.body !== last.body) found.push({ kind: "description", body: snap.body });
  // What the run itself writes is not news to it.
  const fresh = (snap.comments ?? [])
    .slice((last.comments ?? []).length)
    .filter((one) => one.author?.login !== me);
  if (fresh.length > 0) found.push({ kind: "comments", comments: fresh.map(written) });
  return found;
}

/** The head a ref points at, each time it changes. The first poll is only a baseline. */
export function movesOf(
  read: () => Promise<string>,
  rest: () => Promise<void>,
): { next(): Promise<{ sha: string }> } {
  let last: string | undefined;
  return {
    async next(): Promise<{ sha: string }> {
      for (;;) {
        try {
          const sha = await read();
          const news = last !== undefined && sha !== last;
          last = sha;
          if (news) return { sha };
        } catch {
          // The next poll tries again. A watch has nowhere to report a passing failure.
        }
        await rest();
      }
    },
  };
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
  description:
    "GitHub issues, pull requests, and branch heads through the gh CLI, under your own login",
  async check(host) {
    const there = await host.shell("command -v gh");
    if (there.code !== 0) {
      return ["gh is not installed. Install it from https://cli.github.com."];
    }
    const token = await host.exec(["gh", "auth", "token"]);
    if (token.code !== 0 || token.stdout.trim() === "") {
      return ["gh is signed out. Run `gh auth login`."];
    }
    return [];
  },
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

    /** graphql wants the owner, the repo, and the number, which a url carries and a ref does not. */
    async function placeFor(ref: string): Promise<Place> {
      const known = placeOf(ref);
      if (known !== undefined) return known;
      const done = await gh(["pr", "view", ref, "--json", "url", "-q", ".url"]);
      if (done.code !== 0) throw new Fault(reasonOf(done));
      const url = done.stdout.trim();
      const found = placeOf(url);
      if (found === undefined) throw new Fault(`the PR url did not read: ${url}`);
      return found;
    }

    /** The whole pull request, or null when the ref names none. Anything else is a fault. */
    async function prOf(ref: string): Promise<Pr | null> {
      const done = await gh(["pr", "view", ref, "--json", PR_FIELDS]);
      if (done.code !== 0) {
        if (/no pull requests found|could not resolve|not found/i.test(done.stderr)) return null;
        throw new Fault(reasonOf(done));
      }
      const found = JSON.parse(done.stdout) as Pr;
      const place = placeOf(found.url);
      if (place === undefined) throw new Fault(`the PR url did not read: ${found.url}`);
      const asked = await gh(queueRead(place));
      if (asked.code !== 0) throw new Fault(reasonOf(asked));
      found.isInMergeQueue = asked.stdout.trim() === "true";
      host.open(found.url);
      return found;
    }

    return {
      branch: {
        /** A handle, not a snapshot, so the trace never replays a poll. A failed poll retries quietly. */
        moved(branch: string): { next(): Promise<{ sha: string }> } {
          return movesOf(
            async () => {
              // gh resolves {owner} and {repo} from the checkout, so the watch needs no url parsing.
              const done = await gh([
                "api",
                `repos/{owner}/{repo}/git/ref/heads/${branch}`,
                "-q",
                ".object.sha",
              ]);
              if (done.code !== 0) throw new Error(reasonOf(done));
              const sha = done.stdout.trim();
              if (sha === "") throw new Error(`origin names no head for ${branch}`);
              return sha;
            },
            () => rested(POLL_MS),
          );
        },
      },
      issue: {
        async get(ref: string): Promise<Issue> {
          const done = await gh(["issue", "view", ref, "--json", ISSUE_FIELDS]);
          if (done.code !== 0) throw new Fault(reasonOf(done));
          const found = JSON.parse(done.stdout) as Issue;
          host.open(found.url);
          return found;
        },
        async comments(ref: string): Promise<Comment[]> {
          const done = await gh(["issue", "view", ref, "--json", "comments"]);
          if (done.code !== 0) throw new Fault(reasonOf(done));
          return commentsOf(done.stdout);
        },
      },
      pr: {
        /** The whole pull request, or null when the ref names none. */
        async get(pr: string): Promise<Pr | null> {
          return prOf(pr);
        },
        async comments(pr: string): Promise<Comment[]> {
          const done = await gh(["pr", "view", pr, "--json", "comments"]);
          if (done.code !== 0) throw new Fault(reasonOf(done));
          return commentsOf(done.stdout);
        },
        /** The review threads still open, each with what was said on it. None is an answer. */
        async threads(pr: string): Promise<Thread[]> {
          const done = await gh(graphql(THREADS_QUERY, await placeFor(pr), THREADS_PATH));
          if (done.code !== 0) throw new Fault(reasonOf(done));
          return openThreads(done.stdout);
        },
        /** The newest merged titles, which are the only record of how this repository writes them. */
        async titles(count: number): Promise<string[]> {
          const done = await gh([
            "pr",
            "list",
            "--state",
            "merged",
            "--limit",
            String(count),
            "--json",
            "title",
          ]);
          if (done.code !== 0) throw new Fault(reasonOf(done));
          return (JSON.parse(done.stdout) as { title: string }[]).map((one) => one.title);
        },
        /** The pull request onto another base, as when the branch it stacked on has merged. */
        async retarget(pr: string, base: string): Promise<void> {
          const done = await gh(["pr", "edit", pr, "--base", base]);
          if (done.code !== 0) throw new Fault(reasonOf(done));
        },
        /** What the branch already has open, with the base each one lands on. None is an answer. */
        async of(branch: string): Promise<Opened[]> {
          const done = await gh([
            "pr",
            "list",
            "--head",
            branch,
            "--state",
            "open",
            "--json",
            OPENED_FIELDS,
          ]);
          if (done.code !== 0) throw new Fault(reasonOf(done));
          return JSON.parse(done.stdout) as Opened[];
        },
        /**
         * A pull request for the branch, whatever the world already holds: the
         * open one comes back as it stands (its base may not be the one asked
         * for; the caller reads pr.baseRefName), a branch whose work already
         * landed answers `landed`, and only when neither is true does one open.
         */
        async ensure(options: {
          head: string;
          base: string;
          title: string;
          body: string;
          cwd?: string;
        }): Promise<{ landed: boolean; pr: Pr | null; created: boolean }> {
          const listed = await gh([
            "pr",
            "list",
            "--head",
            options.head,
            "--state",
            "open",
            "--json",
            OPENED_FIELDS,
          ]);
          if (listed.code !== 0) throw new Fault(reasonOf(listed));
          const open = (JSON.parse(listed.stdout) as Opened[])[0];
          if (open !== undefined) {
            return { landed: false, pr: await prOf(open.url), created: false };
          }
          const merged = await gh([
            "pr",
            "list",
            "--head",
            options.head,
            "--state",
            "merged",
            "--json",
            OPENED_FIELDS,
          ]);
          if (merged.code !== 0) throw new Fault(reasonOf(merged));
          const done = (JSON.parse(merged.stdout) as Opened[])[0];
          if (done !== undefined) {
            return { landed: true, pr: await prOf(done.url), created: false };
          }
          const made = await gh(
            [
              "pr",
              "create",
              "--head",
              options.head,
              "--base",
              options.base,
              "--title",
              options.title,
              "--body-file",
              "-",
            ],
            { cwd: options.cwd, stdin: options.body },
          );
          if (made.code === 0) {
            return { landed: false, pr: await prOf(made.stdout.trim()), created: true };
          }
          // The branch holds nothing the base does not: its work already landed, PR or no PR.
          if (/no commits between/i.test(made.stderr)) {
            return { landed: true, pr: null, created: false };
          }
          // Another writer opened one between the list and the create.
          if (/already exists/.test(made.stderr)) {
            return { landed: false, pr: await prOf(options.head), created: false };
          }
          throw new Fault(reasonOf(made));
        },
        async diff(pr: string): Promise<string> {
          const done = await gh(["pr", "diff", pr]);
          if (done.code !== 0) throw new Fault(reasonOf(done));
          return done.stdout;
        },
        async comment(pr: string, options: { body: string } | { bodyFile: string }): Promise<void> {
          const done =
            "body" in options
              ? await gh(["pr", "comment", pr, "--body-file", "-"], { stdin: options.body })
              : await gh(["pr", "comment", pr, "--body-file", options.bodyFile]);
          if (done.code !== 0) throw new Fault(reasonOf(done));
        },
        /** Answers one review thread. Resolving it stays with whoever opened it. */
        async reply(thread: string, body: string): Promise<void> {
          const done = await gh([
            "api",
            "graphql",
            "-f",
            `query=${REPLY_QUERY}`,
            "-f",
            `thread=${thread}`,
            "-f",
            `body=${body}`,
          ]);
          if (done.code !== 0) throw new Fault(reasonOf(done));
        },
        async approve(pr: string): Promise<void> {
          const done = await gh(["pr", "review", pr, "--approve"]);
          if (done.code !== 0) throw new Fault(reasonOf(done));
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
