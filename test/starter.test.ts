import {
  backupsDir,
  declineStarter,
  ensureStarter,
  extractStarter,
  starterDir,
  starterState,
  version,
} from "@mikaelweiss/penguin-engine/catalog";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

function withHome(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-starter-"));
  const prior = process.env["PENGUIN_HOME"];
  process.env["PENGUIN_HOME"] = dir;
  t.after(() => {
    if (prior === undefined) delete process.env["PENGUIN_HOME"];
    else process.env["PENGUIN_HOME"] = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function stampWith(installed: string): void {
  fs.writeFileSync(path.join(starterDir(), "version"), `${installed}\n`);
}

test("invariant 20: the catalog a binary carries lands on disk, stamped with its version", (t) => {
  withHome(t);
  extractStarter();

  const dir = starterDir();
  assert.equal(fs.readFileSync(path.join(dir, "version"), "utf8"), `${version}\n`);
  for (const file of ["workflows/ship.ts", "adapters/git.ts", "helpers/ticket.ts", "defaults", "tsconfig.json"]) {
    assert.equal(fs.existsSync(path.join(dir, file)), true, file);
  }
  assert.equal(fs.existsSync(path.join(dir, "skills", "penguin-triage", "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(dir, "types", "zod", "package.json")), true);
  assert.equal(starterState().kind, "current");
});

test("invariant 20: a starter directory that is gone comes back", (t) => {
  withHome(t);
  extractStarter();
  fs.rmSync(starterDir(), { recursive: true });

  assert.equal(starterState().kind, "missing");
  ensureStarter();
  assert.equal(starterState().kind, "current");
  assert.equal(fs.existsSync(path.join(starterDir(), "workflows", "ship.ts")), true);
});

test("invariant 20: updating an older catalog moves the whole tree to backups", (t) => {
  withHome(t);
  extractStarter();
  fs.writeFileSync(path.join(starterDir(), "workflows", "mine.ts"), "// edited in place\n");
  stampWith("0.0.1");

  assert.deepEqual(starterState(), { kind: "stale", installed: "0.0.1" });
  const kept = extractStarter();

  assert.equal(kept, path.join(backupsDir(), "starter-0.0.1"));
  assert.equal(fs.readFileSync(path.join(kept!, "workflows", "mine.ts"), "utf8"), "// edited in place\n");
  assert.equal(fs.existsSync(path.join(starterDir(), "workflows", "mine.ts")), false);
  assert.equal(starterState().kind, "current");
});

test("invariant 20: a second backup of the same version keeps the first", (t) => {
  withHome(t);
  extractStarter();
  stampWith("0.0.1");
  extractStarter();
  stampWith("0.0.1");
  const second = extractStarter();

  assert.equal(second, path.join(backupsDir(), "starter-0.0.1-2"));
  assert.equal(fs.existsSync(path.join(backupsDir(), "starter-0.0.1")), true);
});

test("invariant 20: a declined version never asks twice, and keeps the files that are there", (t) => {
  withHome(t);
  extractStarter();
  fs.writeFileSync(path.join(starterDir(), "workflows", "mine.ts"), "// kept\n");
  stampWith("0.0.1");
  declineStarter();

  assert.deepEqual(starterState(), { kind: "declined", installed: "0.0.1" });
  assert.equal(fs.readFileSync(path.join(starterDir(), "workflows", "mine.ts"), "utf8"), "// kept\n");
  assert.equal(fs.existsSync(backupsDir()), false);
});

test("the catalog in the binary is the examples directory, at this version", async () => {
  const { starterFiles, version: carried } = await import(
    "../packages/engine/src/catalog/starter.generated.ts"
  );
  const manifest = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  ) as { version: string };
  const examples = fileURLToPath(new URL("../packages/engine/examples", import.meta.url));

  assert.equal(carried, manifest.version, "run `bun run generate` after a version change");
  for (const found of fs.globSync("**/*", { cwd: examples })) {
    const relative = found.split(path.sep).join("/");
    if (!fs.statSync(path.join(examples, relative)).isFile()) continue;
    assert.equal(
      starterFiles[relative],
      fs.readFileSync(path.join(examples, relative), "utf8"),
      `${relative} differs, run \`bun run generate\``,
    );
  }
});

test("a catalog penguin cannot write says so, and names the directory", (t) => {
  const home = withHome(t);
  fs.chmodSync(home, 0o500);
  t.after(() => fs.chmodSync(home, 0o700));

  assert.throws(() => extractStarter(), (error: Error) => {
    assert.match(error.message, /penguin could not write its catalog to/);
    assert.match(error.message, new RegExp(starterDir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    return true;
  });
});
