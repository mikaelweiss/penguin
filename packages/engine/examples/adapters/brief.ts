import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { adapter, Fault, type CommandResult } from "penguin";

type Rendered = {
  html: string;
  md: string;
  /** Null when no browser was there to shoot the page. */
  png: string | null;
  /** Which version the renderer filed this brief as. It rises only when the brief changed. */
  version: number;
  /** What the renderer refused the brief for, empty when it rendered. */
  problems: string[];
};

/** The renderer names the version it saved or found unchanged, before it prints the pages. */
function versionOf(stderr: string): number {
  const said = /^v(\d+) (?:saved|unchanged)$/m.exec(stderr);
  return said === null ? 1 : Number(said[1]);
}

/** A refusal prints a heading with the count, then one indented line per field it names. */
function problemsOf(done: CommandResult): string[] {
  const listed = done.stderr
    .split("\n")
    .filter((line) => /^\s+\S/.test(line))
    .map((line) => line.trim());
  if (listed.length > 0) return listed;
  const said = (done.stderr + done.stdout).trim();
  return [said === "" ? `the renderer exited ${done.code}` : said];
}

export default adapter({
  role: "brief",
  name: "brief",
  description:
    "change briefs: one JSON file per branch under penguin's home, rendered to the page a person approves a proposal or reads a review from",
  build: (host) => {
    const git = (args: string[]): Promise<CommandResult> => host.exec(["git", ...args]);

    /** The repository, not the checkout, so every worktree of a clone files its briefs under one name. */
    async function repoName(): Promise<string> {
      const common = await git(["rev-parse", "--git-common-dir"]);
      const gitdir = common.stdout.trim();
      const repo = gitdir === "" ? host.cwd : path.dirname(path.resolve(host.cwd, gitdir));
      return path.basename(repo);
    }

    async function branchName(): Promise<string> {
      const done = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
      const name = done.stdout.trim();
      if (done.code !== 0 || name === "") throw new Fault(done.stderr.trim());
      return name;
    }

    return {
      /**
       * Where the brief called `name` belongs, its folder made. `branch` names a
       * scope of its own, a pull request's number, when the checkout is not the subject.
       */
      async where(options: { name: string; branch?: string }): Promise<string> {
        const branch = options.branch ?? (await branchName());
        const dir = path.join(host.home, "briefs", await repoName(), branch);
        fs.mkdirSync(dir, { recursive: true });
        return path.join(dir, `${options.name}.json`);
      },

      /** The pages beside the JSON. A brief the renderer refused writes nothing and names every problem. */
      async render(json: string): Promise<Rendered> {
        const script = path.join(host.skill("brief").dir, "render.mjs");
        const done = await host.exec([process.execPath, script, json]);
        if (done.code !== 0) {
          return { html: "", md: "", png: null, version: 0, problems: problemsOf(done) };
        }
        const printed = done.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "");
        return {
          html: printed[0] ?? "",
          md: printed[1] ?? "",
          png: printed[2] ?? null,
          version: versionOf(done.stderr),
          problems: [],
        };
      },

      /** The version rides in the url, so a brief that changed is a page the browser has not seen. */
      async open(html: string, version: number): Promise<void> {
        const url = pathToFileURL(html);
        url.searchParams.set("v", String(version));
        host.open(url.href);
      },
    };
  },
});
