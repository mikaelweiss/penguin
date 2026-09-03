import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Catalog } from "./catalogs.ts";
import { writeEditorFiles } from "./editor.ts";

let temps: string[] = [];

function catalog(scope: Catalog["scope"], adapters: Record<string, string> = {}): Catalog {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-catalog-"));
  temps.push(dir);
  if (Object.keys(adapters).length > 0) fs.mkdirSync(path.join(dir, "adapters"));
  for (const [role, name] of Object.entries(adapters)) {
    fs.writeFileSync(
      path.join(dir, "adapters", `${name}.ts`),
      `import { adapter } from "penguin";\n` +
        `export default adapter({ role: "${role}", name: "${name}", ` +
        `description: "a test adapter", build: () => ({ ran: () => "${name}" }) });\n`,
    );
  }
  return { dir, scope };
}

function tsconfigIn(dir: string): { compilerOptions: { paths: Record<string, string[]> } } {
  const text = fs.readFileSync(path.join(dir, "tsconfig.json"), "utf8");
  return JSON.parse(text.slice(text.indexOf("\n") + 1)) as ReturnType<typeof tsconfigIn>;
}

afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

test("points the catalog at the running install's own penguin", async () => {
  const project = catalog("project", { vcs: "git" });
  await writeEditorFiles([project]);
  const entry = tsconfigIn(project.dir).compilerOptions.paths["penguin"]?.[0] ?? "";
  expect(path.isAbsolute(entry)).toBe(true);
  expect(fs.existsSync(entry)).toBe(true);
});

test("maps a composed import onto the catalogs a run searches, nearest first", async () => {
  const project = catalog("project", { vcs: "git" });
  const home = catalog("home", { agent: "claude" });
  await writeEditorFiles([project, home]);
  expect(tsconfigIn(project.dir).compilerOptions.paths["penguin:*"]).toEqual([
    path.join(project.dir, "workflows", "*.ts"),
    path.join(home.dir, "workflows", "*.ts"),
  ]);
  expect(tsconfigIn(home.dir).compilerOptions.paths["penguin:*"]).toEqual([
    path.join(home.dir, "workflows", "*.ts"),
  ]);
});

test("types one ctx member per resolved role, from the adapter's own build", async () => {
  const project = catalog("project", { vcs: "git" });
  const home = catalog("home", { agent: "claude" });
  await writeEditorFiles([project, home]);
  const env = fs.readFileSync(path.join(project.dir, "penguin-env.d.ts"), "utf8");
  expect(env).toContain('vcs: ReturnType<(typeof adapter0)["build"]>');
  expect(env).toContain('agent: ReturnType<(typeof adapter1)["build"]>');
  expect(env).toContain(path.join(home.dir, "adapters", "claude.ts"));
});

test("a catalog is typed against what it shadows, never against a caller's folder", async () => {
  const project = catalog("project", { vcs: "git" });
  const home = catalog("home", { agent: "claude" });
  await writeEditorFiles([project, home]);
  const env = fs.readFileSync(path.join(home.dir, "penguin-env.d.ts"), "utf8");
  expect(env).toContain("agent:");
  expect(env).not.toContain("vcs:");
});

test("ignores what it writes, keeping any line the catalog already had", async () => {
  const project = catalog("project", { vcs: "git" });
  fs.writeFileSync(path.join(project.dir, ".gitignore"), "notes.md\ntsconfig.json\n");
  await writeEditorFiles([project]);
  const ignored = fs.readFileSync(path.join(project.dir, ".gitignore"), "utf8");
  expect(ignored).toBe("notes.md\ntsconfig.json\npenguin-env.d.ts\n");
});

test("leaves the catalogs that live inside the install alone", async () => {
  const starter = catalog("starter", { vcs: "git" });
  const builtin = catalog("builtin");
  await writeEditorFiles([starter, builtin]);
  expect(fs.existsSync(path.join(starter.dir, "tsconfig.json"))).toBe(false);
  expect(fs.existsSync(path.join(builtin.dir, "tsconfig.json"))).toBe(false);
});

test("rewrites nothing when the answer has not changed", async () => {
  const project = catalog("project", { vcs: "git" });
  await writeEditorFiles([project]);
  const file = path.join(project.dir, "tsconfig.json");
  const before = fs.statSync(file).mtimeMs;
  await writeEditorFiles([project]);
  expect(fs.statSync(file).mtimeMs).toBe(before);
});

test("leaves a folder that holds no definitions alone", async () => {
  const empty = catalog("project");
  await writeEditorFiles([empty]);
  expect(fs.readdirSync(empty.dir)).toEqual([]);
});

test("drops what it wrote once a catalog's definitions are gone", async () => {
  const project = catalog("project", { vcs: "git" });
  await writeEditorFiles([project]);
  fs.rmSync(path.join(project.dir, "adapters"), { recursive: true });
  await writeEditorFiles([project]);
  expect(fs.existsSync(path.join(project.dir, "tsconfig.json"))).toBe(false);
  expect(fs.existsSync(path.join(project.dir, "penguin-env.d.ts"))).toBe(false);
});

test("never drops a tsconfig it did not write", async () => {
  const project = catalog("project");
  fs.writeFileSync(path.join(project.dir, "tsconfig.json"), "{}\n");
  await writeEditorFiles([project]);
  expect(fs.readFileSync(path.join(project.dir, "tsconfig.json"), "utf8")).toBe("{}\n");
});

test("counts a skills-only catalog as nothing to type", async () => {
  const project = catalog("project");
  fs.mkdirSync(path.join(project.dir, "skills", "review"), { recursive: true });
  await writeEditorFiles([project]);
  expect(fs.existsSync(path.join(project.dir, "tsconfig.json"))).toBe(false);
});
