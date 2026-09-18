import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResult, Host, Skill } from "../src/core/adapter.ts";
import definition from "../examples/adapters/brief.ts";

let temps: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

type Ran = (argv: string[]) => CommandResult;

type Fake = {
  brief: ReturnType<(typeof definition)["build"]>;
  home: string;
  skillDir: string;
  argvs: string[][];
  opened: string[];
};

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });

function fake(options: { cwd?: string; ran: Ran }): Fake {
  const home = tempDir("penguin-brief-home-");
  const skillDir = tempDir("penguin-brief-skill-");
  const argvs: string[][] = [];
  const opened: string[] = [];
  const skill: Skill = {
    name: "brief",
    description: "renders a brief",
    dir: skillDir,
    text: "Write the brief.",
  };
  const host: Host = {
    cwd: options.cwd ?? "/repos/penguin",
    home,
    state: home,
    run: { id: "test", dir: home },
    config: () => undefined,
    secret: async () => undefined,
    note: () => {},
    open: (url) => opened.push(url),
    skill: () => skill,
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: async (argv) => {
      argvs.push(argv);
      return options.ran(argv);
    },
    spawn: () => {
      throw new Error("the brief adapter execs, it does not spawn");
    },
  };
  return { brief: definition.build(host), home, skillDir, argvs, opened };
}

const gitAnswers =
  (common: string, branch: string): Ran =>
  (argv) => {
    if (argv[2] === "--git-common-dir") return ok(`${common}\n`);
    if (argv[2] === "--abbrev-ref") return ok(`${branch}\n`);
    return { code: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` };
  };

test("the brief path buckets by repository and branch, and its folder is made", async () => {
  const { brief, home } = fake({ ran: gitAnswers("/repos/penguin/.git", "brief-workflows") });
  const file = await brief.where({ name: "proposal" });
  expect(file).toBe(path.join(home, "briefs", "penguin", "brief-workflows", "proposal.json"));
  expect(fs.existsSync(path.dirname(file))).toBe(true);
});

test("a worktree files under the repository that owns it, not its own folder", async () => {
  const { brief, home } = fake({
    cwd: "/worktrees/penguin/brief-workflows",
    ran: gitAnswers("/repos/penguin/.git", "brief-workflows"),
  });
  const file = await brief.where({ name: "review" });
  expect(file).toBe(path.join(home, "briefs", "penguin", "brief-workflows", "review.json"));
});

test("a branch with a slash nests, which is the shape it already has", async () => {
  const { brief, home } = fake({ ran: gitAnswers("/repos/penguin/.git", "react/foo") });
  const file = await brief.where({ name: "proposal" });
  expect(file).toBe(path.join(home, "briefs", "penguin", "react", "foo", "proposal.json"));
  expect(fs.existsSync(path.dirname(file))).toBe(true);
});

test("a named branch scopes the brief to a pull request, and git is never asked", async () => {
  const { brief, home, argvs } = fake({ ran: gitAnswers("/repos/penguin/.git", "brief-workflows") });
  const file = await brief.where({ name: "review", branch: "pr-123" });
  expect(file).toBe(path.join(home, "briefs", "penguin", "pr-123", "review.json"));
  expect(argvs.map((argv) => argv[2])).toEqual(["--git-common-dir"]);
});

test("render runs the skill's renderer and hands back the pages it printed", async () => {
  const { brief, skillDir, argvs } = fake({
    ran: () => ok("/briefs/proposal.html\n/briefs/proposal.md\n/briefs/proposal.png\n"),
  });
  const rendered = await brief.render("/briefs/proposal.json");
  expect(argvs[0]).toEqual([
    process.execPath,
    path.join(skillDir, "render.mjs"),
    "/briefs/proposal.json",
  ]);
  expect(rendered).toEqual({
    html: "/briefs/proposal.html",
    md: "/briefs/proposal.md",
    png: "/briefs/proposal.png",
    version: 1,
    problems: [],
  });
});

test("a renderer that could not shoot the page prints two paths and still succeeded", async () => {
  const { brief } = fake({
    ran: () => ({
      code: 0,
      stdout: "/briefs/proposal.html\n/briefs/proposal.md\n",
      stderr: "v1 saved\nno png: playwright-core not found\n",
    }),
  });
  expect(await brief.render("/briefs/proposal.json")).toEqual({
    html: "/briefs/proposal.html",
    md: "/briefs/proposal.md",
    png: null,
    version: 1,
    problems: [],
  });
});

test("the version the renderer filed the brief under comes back with the pages", async () => {
  const pages = "/briefs/proposal.html\n/briefs/proposal.md\n";
  const saved = fake({ ran: () => ({ code: 0, stdout: pages, stderr: "v4 saved\n" }) });
  const same = fake({ ran: () => ({ code: 0, stdout: pages, stderr: "v4 unchanged\n" }) });
  expect((await saved.brief.render("/briefs/proposal.json")).version).toBe(4);
  expect((await same.brief.render("/briefs/proposal.json")).version).toBe(4);
});

test("a refused brief renders nothing and reports the line for each field", async () => {
  const { brief } = fake({
    ran: () => ({
      code: 1,
      stdout: "",
      stderr:
        "/briefs/proposal.json: 2 problems, nothing rendered\n  title: missing\n  behaviors: empty\n",
    }),
  });
  expect(await brief.render("/briefs/proposal.json")).toEqual({
    html: "",
    md: "",
    png: null,
    version: 0,
    problems: ["title: missing", "behaviors: empty"],
  });
});

test("a failure in no shape the adapter knows reports what the renderer said", async () => {
  const { brief } = fake({
    ran: () => ({ code: 1, stdout: "", stderr: "SyntaxError: Unexpected token }\n" }),
  });
  const rendered = await brief.render("/briefs/proposal.json");
  expect(rendered.problems).toEqual(["SyntaxError: Unexpected token }"]);
});

test("open hands the page over with its version, which a re-render changes", async () => {
  const { brief, opened } = fake({ ran: () => ok("") });
  await brief.open("/briefs/proposal.html", 1);
  await brief.open("/briefs/proposal.html", 1);
  await brief.open("/briefs/proposal.html", 2);
  expect(opened).toEqual([
    "file:///briefs/proposal.html?v=1",
    "file:///briefs/proposal.html?v=1",
    "file:///briefs/proposal.html?v=2",
  ]);
});

test("a branch a url would break on survives the trip to the browser", async () => {
  const { brief, opened } = fake({ ran: () => ok("") });
  await brief.open("/briefs/penguin/fix#42 and more/proposal.html", 3);
  const url = new URL(opened[0] ?? "");
  expect(decodeURIComponent(url.pathname)).toBe("/briefs/penguin/fix#42 and more/proposal.html");
  expect(url.searchParams.get("v")).toBe("3");
});

test("the skill's own renderer writes the page and the markdown from its examples", async () => {
  const dir = tempDir("penguin-brief-render-");
  const examples = path.join(import.meta.dir, "..", "examples", "skills", "brief");
  const script = path.join(examples, "render.mjs");
  for (const name of ["example.json", "example-review.json"]) {
    const json = path.join(dir, name);
    fs.copyFileSync(path.join(examples, name), json);
    const done = Bun.spawnSync([process.execPath, script, json]);
    expect({ name, code: done.exitCode }).toEqual({ name, code: 0 });
    expect(fs.existsSync(json.replace(/\.json$/, ".html"))).toBe(true);
    expect(fs.existsSync(json.replace(/\.json$/, ".md"))).toBe(true);
  }
}, 120000);

test("the renderer files each brief it is given as a version, and says which one", async () => {
  const dir = tempDir("penguin-brief-version-");
  const examples = path.join(import.meta.dir, "..", "examples", "skills", "brief");
  const script = path.join(examples, "render.mjs");
  const json = path.join(dir, "proposal.json");
  const brief = JSON.parse(fs.readFileSync(path.join(examples, "example.json"), "utf8"));
  const render = (): string => {
    const done = Bun.spawnSync([process.execPath, script, json]);
    expect(done.exitCode).toBe(0);
    return done.stderr.toString();
  };

  fs.writeFileSync(json, JSON.stringify(brief));
  expect(render()).toContain("v1 saved");
  expect(render()).toContain("v1 unchanged");

  brief.notes = '---\n## Notes from "Rate-limit password reset requests" v1\n- 3. a\n---';
  fs.writeFileSync(json, JSON.stringify(brief));
  expect(render()).toContain("v2 saved");

  // The version before this one keeps a page of its own, so the ticks made on it stand.
  expect(fs.existsSync(path.join(dir, "history", "proposal.v1.html"))).toBe(true);
  expect(fs.readFileSync(path.join(dir, "proposal.html"), "utf8")).toContain("- 3. a");
}, 120000);
