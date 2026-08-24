import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe } from "./describe.ts";

const ECHO = `import { adapter } from "penguin";
export default adapter({
  role: "echo",
  name: "test",
  description: "echoes back",
  build: () => ({}),
});
`;

const HELLO = `import { workflow } from "penguin";
import { z } from "zod";
export default workflow({
  description: "greets by echo",
  params: z.object({ name: z.string().describe("who to greet") }),
  async run() {
    return null;
  },
});
`;

let temps: string[] = [];
let project = "";

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-home-"));
  process.env["PENGUIN_HOME"] = home;
  project = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-project-"));
  temps.push(home, project);
  const local = path.join(project, ".penguin");
  fs.mkdirSync(path.join(local, "workflows"), { recursive: true });
  fs.mkdirSync(path.join(local, "adapters"), { recursive: true });
  fs.mkdirSync(path.join(local, "skills", "greet"), { recursive: true });
  fs.writeFileSync(path.join(local, "workflows", "hello.ts"), HELLO);
  fs.writeFileSync(path.join(local, "adapters", "echo.ts"), ECHO);
  fs.writeFileSync(
    path.join(local, "skills", "greet", "SKILL.md"),
    "---\nname: greet\ndescription: greets. Use for tests.\n---\n\nSay hello.\n",
  );
});

afterEach(() => {
  delete process.env["PENGUIN_HOME"];
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

test("describes the catalogs as plain JSON: workflows, skills, adapters", async () => {
  const described = await describe(project);
  const hello = described.workflows.find((entry) => entry.name === "hello");
  expect(hello?.description).toBe("greets by echo");
  expect(hello?.params?.["type"]).toBe("object");
  expect(hello?.error).toBeUndefined();
  const greet = described.skills.find((entry) => entry.name === "greet");
  expect(greet?.description).toBe("greets. Use for tests.");
  expect(greet?.scope).toBe("project");
  const echo = described.adapters.find((entry) => entry.role === "echo");
  expect(echo?.name).toBe("test");
  expect(described.errors).toEqual([]);
});

test("a workflow that refuses to load keeps its slot, with the error", async () => {
  fs.writeFileSync(path.join(project, ".penguin", "workflows", "broken.ts"), "export default 5;");
  const described = await describe(project);
  const broken = described.workflows.find((entry) => entry.name === "broken");
  expect(broken?.error).toContain("does not default-export a workflow");
  expect(described.workflows.find((entry) => entry.name === "hello")?.description).toBe(
    "greets by echo",
  );
});
