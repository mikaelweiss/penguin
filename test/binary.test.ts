import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const binary = path.join(root, "dist", `penguin-${process.platform}-${process.arch}`, "bin", "pn");

const smoke = `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "write one fact and finish",
  params: z.object({ note: z.string().default("hello") }),

  async run({ params, view }) {
    view.fact({ note: params.note });
    return params.note;
  },
});
`;

function built(): void {
  const done = spawnSync("bun", [path.join(root, "scripts", "build.ts"), "--single", "--skip-install"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(done.status, 0, `${done.stdout}${done.stderr}`);
}

function box(t: TestContext): { home: string; run: (...args: string[]) => { code: number; output: string } } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "penguin-binary-")));
  const home = path.join(dir, "home");
  const state = path.join(dir, "state");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    home,
    run(...args) {
      const done = spawnSync(binary, args, {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PENGUIN_HOME: home, HOME: dir, XDG_STATE_HOME: state },
      });
      return { code: done.status ?? 1, output: `${done.stdout}${done.stderr}` };
    },
  };
}

test("the compiled binary installs, carries the catalog, and runs a workflow", (t) => {
  built();
  const penguin = box(t);

  const named = penguin.run("--version");
  assert.equal(named.code, 0, named.output);
  assert.match(named.output, /^\d+\.\d+\.\d+/);

  const listed = penguin.run("list", "workflows");
  assert.equal(listed.code, 0, listed.output);
  assert.match(listed.output, /\bship\b/);

  const starter = path.join(penguin.home, "starter");
  for (const file of ["workflows/ship.ts", "adapters/git.ts", "helpers/ticket.ts", "version"]) {
    assert.equal(fs.existsSync(path.join(starter, file)), true, file);
  }
  assert.equal(fs.existsSync(path.join(starter, "skills", "penguin-triage", "SKILL.md")), true);
  assert.equal(fs.readFileSync(path.join(penguin.home, "catalogs"), "utf8"), "starter\n");

  fs.mkdirSync(path.join(penguin.home, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(penguin.home, "workflows", "smoke.ts"), smoke);
  const ran = penguin.run("run", "smoke", "--note", "from the binary");
  assert.equal(ran.code, 0, ran.output);
  assert.match(ran.output, /from the binary/);
});
