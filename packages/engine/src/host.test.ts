import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Host } from "./core/adapter.ts";
import { roots } from "./catalog/catalogs.ts";
import { skillLookup } from "./catalog/skills.ts";
import { createHost } from "./host.ts";

function hostFor(dir: string): Host {
  return createHost(dir, { id: "test", dir }, skillLookup(roots(dir)));
}

let temps: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-host-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

test("shell captures stdout, stderr, and the exit code", async () => {
  const host = hostFor(tempDir());
  const done = await host.shell("printf hi; printf oops >&2; exit 3");
  expect(done).toEqual({ code: 3, stdout: "hi", stderr: "oops" });
});

test("exec passes arguments without a shell, so nothing needs quoting", async () => {
  const host = hostFor(tempDir());
  const done = await host.exec(["printf", "%s", "a b '\"$HOME"]);
  expect(done.code).toBe(0);
  expect(done.stdout).toBe("a b '\"$HOME");
});

test("stdin reaches the child", async () => {
  const host = hostFor(tempDir());
  const done = await host.exec(["cat"], { stdin: "typed text" });
  expect(done.stdout).toBe("typed text");
});

test("an empty argv throws instead of faking a failed command", () => {
  const host = hostFor(tempDir());
  expect(() => host.exec([])).toThrow("exec needs a command");
});

test("relative cwd options resolve against the run's folder", async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "sub"));
  const host = hostFor(dir);
  const done = await host.shell("pwd", { cwd: "sub" });
  expect(done.stdout.trim().endsWith("sub")).toBe(true);
});

test("onOutput streams chunks while exec still captures them", async () => {
  const host = hostFor(tempDir());
  let streamed = "";
  const done = await host.exec(["printf", "hello"], {
    onOutput: (chunk, stream) => {
      if (stream === "stdout") streamed += chunk;
    },
  });
  expect(streamed).toBe("hello");
  expect(done.stdout).toBe("hello");
});

test("skill reads one skill from the given catalogs", () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "skills", "greet"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "skills", "greet", "SKILL.md"),
    "---\nname: greet\ndescription: greets. Use for tests.\n---\n\nSay hello.\n",
  );
  const host = createHost(dir, { id: "test", dir }, skillLookup([{ dir, scope: "project" }]));
  const skill = host.skill("greet");
  expect(skill.description).toBe("greets. Use for tests.");
  expect(skill.text).toBe("Say hello.");
  expect(skill.dir).toBe(path.join(dir, "skills", "greet"));
});

test("an unknown skill throws and names the installed ones", () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, "skills", "greet"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "skills", "greet", "SKILL.md"),
    "---\nname: greet\ndescription: greets. Use for tests.\n---\n\nSay hello.\n",
  );
  const host = createHost(dir, { id: "test", dir }, skillLookup([{ dir, scope: "project" }]));
  expect(() => host.skill("missing")).toThrow("no skill named missing. Installed: greet");
});

test("aborting the signal kills the process", async () => {
  const host = hostFor(tempDir());
  const controller = new AbortController();
  const begun = Date.now();
  const running = host.exec(["sleep", "5"], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  const done = await running;
  expect(done.code).not.toBe(0);
  expect(Date.now() - begun).toBeLessThan(3000);
});
