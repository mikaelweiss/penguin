import { describe, expect, test } from "bun:test";
import {
  changedIn,
  comment,
  declarations,
  graphOf,
  importsIn,
  mentions,
  parseHunks,
  relatedTo,
  resolveImport,
  sizeOf,
  testsFor,
  type Report,
  type Tree,
} from "./jev.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 export function a() {
+  return 1;
 }
@@ -10,2 +11,2 @@
-old
+new
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,1 +1,2 @@
+test("a", () => {});
diff --git a/bun.lock b/bun.lock
--- a/bun.lock
+++ b/bun.lock
@@ -1,1 +1,1 @@
-x
+y
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
--- a/src/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const gone = 1;
diff --git a/src/moved.ts b/src/renamed.ts
similarity index 100%
rename from src/moved.ts
rename to src/renamed.ts
`;

describe("changedIn", () => {
  test("keeps source hunks, sets tests apart, and skips locks, binaries, and pure renames", () => {
    const { files, tests } = changedIn(DIFF);
    expect(files.map((one) => one.path)).toEqual(["src/a.ts", "src/gone.ts"]);
    expect(tests.map((one) => one.path)).toEqual(["src/a.test.ts"]);
    expect(files[0]?.patch.startsWith("@@ -1,3 +1,4 @@")).toBe(true);
    expect(files[0]?.patch).not.toContain("+++ b/src/a.ts");
  });
});

describe("sizeOf", () => {
  test("counts the files touched and the lines added or removed, headers apart", () => {
    expect(sizeOf(DIFF)).toEqual({ files: 4, lines: 7 });
  });

  test("an empty diff is nothing to read", () => {
    expect(sizeOf("")).toEqual({ files: 0, lines: 0 });
  });
});

describe("parseHunks", () => {
  test("numbers hunks and reads the new-file line each starts on", () => {
    const hunks = parseHunks(changedIn(DIFF).files[0]?.patch ?? "");
    expect(hunks.map((one) => [one.id, one.startLine])).toEqual([
      ["hunk_1", 1],
      ["hunk_2", 11],
    ]);
    expect(hunks[1]?.patch).toBe("@@ -10,2 +11,2 @@\n-old\n+new");
  });
});

describe("importsIn", () => {
  test("reads default, named, aliased, type, namespace, and re-exported bindings", () => {
    const found = importsIn(`
import fs from "node:fs";
import { a, b as c, type D } from "./x.ts";
import * as all from "./y.ts";
import type { E } from "../z";
export { f } from "./w.ts";
export * from "./v.ts";
import "./side.ts";
`);
    expect(found).toEqual([
      { module: "node:fs", names: ["default"] },
      { module: "./x.ts", names: ["a", "b", "D"] },
      { module: "./y.ts", names: [] },
      { module: "../z", names: ["E"] },
      { module: "./w.ts", names: ["f"] },
      { module: "./v.ts", names: [] },
    ]);
  });
});

describe("resolveImport", () => {
  const has = (file: string): boolean =>
    ["src/x.ts", "src/lib/index.ts", "src/y.tsx", "src/data.json"].includes(file);
  test("lands relative paths on the tree's source files and skips packages", () => {
    expect(resolveImport("src/a.ts", "./x.ts", has)).toBe("src/x.ts");
    expect(resolveImport("src/a.ts", "./x", has)).toBe("src/x.ts");
    expect(resolveImport("src/a.ts", "./x.js", has)).toBe("src/x.ts");
    expect(resolveImport("src/deep/b.ts", "../lib", has)).toBe("src/lib/index.ts");
    expect(resolveImport("src/a.ts", "./y", has)).toBe("src/y.tsx");
    expect(resolveImport("src/a.ts", "./data.json", has)).toBeUndefined();
    expect(resolveImport("src/a.ts", "zod", has)).toBeUndefined();
  });
});

describe("declarations", () => {
  const text = `import x from "./x.ts";

/** doc */
export const ONE = 1;
export type Shape = { a: number };
export function run(a: number): number {
  if (a > 0) {
    return a;
  }
  return 0;
}
export default class Thing {
  go(): void {}
}
function hidden(): void {}
`;
  test("takes each named export from its line to the end of its block", () => {
    const said = declarations(text, ["run", "ONE", "missing"]);
    expect(said).toContain("// line 6\nexport function run(a: number): number {");
    expect(said).toContain("  return 0;\n}");
    expect(said).toContain("// line 4\nexport const ONE = 1;");
    expect(said).not.toContain("hidden");
  });
  test("takes every export when the importer took the whole module", () => {
    const said = declarations(text, []);
    expect(said).toContain("export type Shape");
    expect(said).toContain("export default class Thing");
    expect(said).not.toContain("hidden");
  });
});

describe("mentions", () => {
  test("windows around each use, merged when they overlap", () => {
    const text = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    text[4] = "run(1)";
    text[7] = "run(2)";
    text[24] = "const y = runner";
    const said = mentions(text.join("\n"), ["run"]);
    expect(said.split("// line ")).toHaveLength(2);
    expect(said).toContain("// line 2\n");
    expect(said).toContain("line 11");
    expect(said).not.toContain("runner");
  });
});

describe("relatedTo and testsFor", () => {
  const files: Record<string, string> = {
    "src/a.ts": `import { helper } from "./lib/helper.ts";\nexport function a(): number {\n  return helper(1);\n}\n`,
    "src/lib/helper.ts": `export function helper(n: number): number {\n  return n;\n}\nexport const unused = 2;\n`,
    "src/caller.ts": `import { a } from "./a.ts";\n\nexport function caller(): number {\n  return a() + 1;\n}\n`,
    "src/a.test.ts": `import { a } from "./a.ts";\ntest("a", () => a());\n`,
    "src/whole.ts": `import * as A from "./a.ts";\nexport const n = A.a();\n`,
    "src/other.test.ts": `test("other", () => 1);\n`,
    "README.md": "# hi",
  };
  const tree: Tree = { files: Object.keys(files), read: (file) => files[file] };
  const graph = graphOf(tree);

  test("hands back the imported declarations first, then the callers and the tests", () => {
    const related = relatedTo(graph, tree, "src/a.ts");
    expect(related.map((one) => [one.path, one.role])).toEqual([
      ["src/lib/helper.ts", "imported"],
      ["src/caller.ts", "importer"],
      ["src/a.test.ts", "test"],
      ["src/whole.ts", "importer"],
    ]);
    expect(related[3]?.text).toContain("A.a()");
    expect(related[0]?.text).toContain("export function helper");
    expect(related[0]?.text).not.toContain("unused");
    expect(related[1]?.text).toContain("return a() + 1;");
  });

  test("names the changed tests that import the file or share its stem", () => {
    const tests = [
      { path: "src/a.test.ts", patch: "", cut: false },
      { path: "src/other.test.ts", patch: "", cut: false },
      { path: "tests/a.spec.ts", patch: "", cut: false },
    ];
    expect(testsFor(graph, tests, "src/a.ts").map((one) => one.path)).toEqual([
      "src/a.test.ts",
      "tests/a.spec.ts",
    ]);
  });
});

describe("comment", () => {
  const report: Report = {
    files: 2,
    tests: 1,
    context: 3,
    signal: 0.7,
    matrix: [
      {
        path: "src/a.ts",
        cut: false,
        cells: { correctness: 0.12, security: 0.83, reliability: 0.2, compatibility: 0.31, testGap: 0.44 },
      },
      {
        path: "src/b.ts",
        cut: true,
        cells: { correctness: 0.9, security: 0.1, reliability: 0.1, compatibility: 0.1, testGap: 0.1 },
      },
    ],
    profiles: [{ path: "src/a.ts", category: "behavior", priority: 2.2 }],
    findings: [
      {
        path: "src/a.ts",
        line: 42,
        dimension: "security",
        probability: 0.83,
        mechanism: "injection",
        severity: 2.4,
        owner: "security",
        action: "request changes",
      },
    ],
    funnel: { cells: 10, signals: 2, inspected: 2, located: 1, routed: 1 },
  };

  test("writes the numbers, the profiles, the matrix, and the findings as tables", () => {
    const said = comment(report, "`abc1234`");
    expect(said).toContain("## Jev pass on `abc1234`");
    expect(said).toContain("| 2 | 1 | 2 | 1 | 1 |");
    expect(said).toContain("10 cells screened, 2 at or above 0.70, 2 inspected, 1 located, 1 routed");
    expect(said).toContain("| `src/a.ts` | Behavior | 2.2 / 3 |");
    expect(said.indexOf("`src/b.ts` (patch cut)")).toBeLessThan(said.indexOf("| `src/a.ts` | 0.12"));
    expect(said).toContain("**0.83**");
    expect(said).toContain("| `src/a.ts:42` | Security | Injection | 2.4 / 3 | Security | request changes |");
    expect(said).toContain("3 related files as context");
  });

  test("says when no finding held up", () => {
    const said = comment({ ...report, findings: [] }, "the working tree");
    expect(said).toContain("No signal held up to the evidence in its hunks.");
  });
});
