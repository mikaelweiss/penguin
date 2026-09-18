import { describe, expect, test } from "bun:test";
import {
  reading,
  aliasesOf,
  codeAt,
  changedIn,
  comment,
  declarations,
  diffFor,
  declarationsThrough,
  graphOf,
  importsIn,
  mentions,
  parseHunks,
  relatedTo,
  resolveImport,
  probeSignals,
  sizeOf,
  testNamesIn,
  testsFor,
  testSummaries,
  twinsOf,
  type Report,
  type Tree,
} from "./jev.ts";

const CELLS = { correctness: 0.1, security: 0.1, reliability: 0.1, compatibility: 0.1, testGap: 0.1 };

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

  test("splits a long hunk into windows, each starting where its first kept line lands", () => {
    const body = Array.from({ length: 90 }, (_, index) => (index === 45 ? "-gone" : `+line ${index + 1}`));
    const hunks = parseHunks(["@@ -0,0 +5,89 @@", ...body].join("\n"));
    expect(hunks.map((one) => one.startLine)).toEqual([5, 45, 84]);
    expect(hunks[1]?.patch.startsWith("@@ from line 45 of the new file @@\n+line 41")).toBe(true);
    expect(hunks[2]?.patch.split("\n")).toHaveLength(11);
  });
});

describe("importsIn for php", () => {
  test("reads plain, aliased, and grouped use lines as the class they name", () => {
    const found = importsIn(
      `<?php\nnamespace App\\A;\n\nuse App\\Models\\Project;\nuse App\\Support\\Locked as L;\nuse App\\Domains\\{One, Two\\Three};\nuse function App\\helper;\n`,
      "app/A/Thing.php",
    );
    expect(found).toEqual([
      { module: "App\\Models\\Project", names: ["Project"] },
      { module: "App\\Support\\Locked", names: ["Locked"] },
      { module: "App\\helper", names: ["helper"] },
      { module: "App\\Domains\\One", names: ["One"] },
      { module: "App\\Domains\\Two\\Three", names: ["Three"] },
    ]);
  });
});

describe("aliasesOf and resolveImport", () => {
  const files: Record<string, string> = {
    "tsconfig.base.json": `{\n  // paths\n  "compilerOptions": { "paths": { "@app/core": ["libs/core/src/index.ts"], "@app/*": ["libs/*/src/index.ts"], } }\n}`,
    "apps/api/composer.json": `{ "autoload": { "psr-4": { "App\\\\": "app/" } }, "autoload-dev": { "psr-4": { "Tests\\\\": "tests/" } } }`,
    "libs/core/src/index.ts": "",
    "libs/ui/src/index.ts": "",
    "apps/api/app/Models/Project.php": "",
    "apps/api/tests/Feature/ProjectTest.php": "",
  };
  const tree: Tree = { files: Object.keys(files), read: (file) => files[file] };
  const aliases = aliasesOf(tree);
  const has = (file: string): boolean => file in files;

  test("reads tsconfig paths through comments and trailing commas, and composer psr-4 by folder", () => {
    expect(aliases.paths).toEqual([
      { key: "@app/core", target: "libs/core/src/index.ts" },
      { key: "@app/*", target: "libs/*/src/index.ts" },
    ]);
    expect(aliases.namespaces).toEqual([
      { prefix: "Tests\\", dir: "apps/api/tests" },
      { prefix: "App\\", dir: "apps/api/app" },
    ]);
  });

  test("lands an alias, a wildcard alias, and a php class on the tree's files", () => {
    expect(resolveImport("libs/x/src/a.ts", "@app/core", has, aliases)).toBe("libs/core/src/index.ts");
    expect(resolveImport("libs/x/src/a.ts", "@app/ui", has, aliases)).toBe("libs/ui/src/index.ts");
    expect(resolveImport("libs/x/src/a.ts", "@app/none", has, aliases)).toBeUndefined();
    expect(resolveImport("apps/api/app/A.php", "App\\Models\\Project", has, aliases)).toBe("apps/api/app/Models/Project.php");
    expect(resolveImport("apps/api/app/A.php", "Illuminate\\Support\\Str", has, aliases)).toBeUndefined();
  });
});

describe("declarations for php and through barrels", () => {
  test("takes a php class as its callers see it: the declaration and each public signature", () => {
    const said = declarations(
      `<?php\n\nfinal class Thing\n{\n    public function __construct(private Dep $dep) {}\n\n    public function run(\n        int $a,\n    ): int {\n        return $a;\n    }\n\n    private function hidden(): void {}\n}\n`,
      [],
      "app/Thing.php",
    );
    expect(said).toContain("// line 3\nfinal class Thing");
    expect(said).toContain("// line 7\n    public function run(\n        int $a,\n    ): int {");
    expect(said).not.toContain("hidden");
  });

  test("follows a barrel's re-export to the file that declares the name", () => {
    const files: Record<string, string> = {
      "lib/index.ts": `export { run } from "./run.ts";\nexport * from "./more.ts";\nexport const HERE = 1;\n`,
      "lib/run.ts": `export function run(): number {\n  return 1;\n}\n`,
      "lib/more.ts": `export function more(): number {\n  return 2;\n}\n`,
    };
    const tree: Tree = { files: Object.keys(files), read: (file) => files[file] };
    const graph = graphOf(tree);
    const said = declarationsThrough(graph, tree, "lib/index.ts", ["run", "more", "HERE"]);
    expect(said).toContain("export const HERE = 1;");
    expect(said).toContain("// from lib/run.ts\n// line 1\nexport function run(): number {");
    expect(said).toContain("// from lib/more.ts");
  });
});

describe("testNamesIn and testSummaries", () => {
  test("reads vitest names, php test methods, and attributed methods from added lines", () => {
    const names = testNamesIn(
      [
        "@@ -0,0 +1,9 @@",
        "+describe('thing', () => {",
        "+  it('starts on save', async () => {",
        "+  test.each(cases)('handles %s', () => {",
        "-  it('gone', () => {",
        "+    public function test_start_rejects_a_reused_id(): void",
        "+    #[Test]",
        "+    public function completes_once(): void",
        "+    public function helper(): void",
      ].join("\n"),
    );
    expect(names).toEqual([
      "thing",
      "starts on save",
      "handles %s",
      "start rejects a reused id",
      "completes once",
    ]);
  });

  test("puts the tests the tree ties to the file first and marks them", () => {
    const files: Record<string, string> = {
      "src/a.ts": "export function a(): number {\n  return 1;\n}\n",
      "src/a.test.ts": `import { a } from "./a.ts";\n`,
      "src/other.test.ts": "",
    };
    const tree: Tree = { files: Object.keys(files), read: (file) => files[file] };
    const graph = graphOf(tree);
    const tests = [
      { path: "src/other.test.ts", patch: "+it('other', () => {})", cut: false },
      { path: "src/a.test.ts", patch: "+it('a works', () => {})", cut: false },
      { path: "src/empty.test.ts", patch: "+const x = 1;", cut: false },
    ];
    expect(testSummaries(graph, tests, "src/a.ts")).toEqual([
      { path: "src/a.test.ts", targeted: true, tests: ["a works"] },
      { path: "src/other.test.ts", targeted: false, tests: ["other"] },
    ]);
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

describe("probeSignals", () => {
  test("takes the strongest per probe above the floor, and never follows a test gap", () => {
    const matrix = [
      { path: "a", probes: { staleCache: 0.9, flagLeak: 0.1, reliability: 0.3, testGap: 0.95 } },
      { path: "b", probes: { staleCache: 0.8, flagLeak: 0.1, reliability: 0.2, testGap: 0.95 } },
      { path: "c", probes: { staleCache: 0.7, flagLeak: 0.1, reliability: 0.1, testGap: 0.95 } },
      { path: "d", probes: { staleCache: 0.1, flagLeak: 0.1, reliability: 0.25, testGap: 0.95 } },
    ];
    const dimensions = { staleCache: "correctness", flagLeak: "security", reliability: "reliability", testGap: "testGap" } as const;
    const picked = probeSignals(matrix, dimensions, { floor: 0.2, perProbe: 2 });
    expect(picked.map((one) => `${one.path}/${one.probe}`)).toEqual([
      "a/staleCache",
      "b/staleCache",
      "a/reliability",
      "d/reliability",
    ]);
    expect(picked[0]?.dimension).toBe("correctness");
  });
});

describe("twinsOf", () => {
  test("finds the same file under a sibling folder with the folder's tokens swapped in the name", () => {
    const tree: Tree = {
      files: [
        "lib/attachment-uploads/persistence/list-attachment-uploads.ts",
        "lib/media-uploads/persistence/list-media-uploads.ts",
        "lib/media-uploads/persistence/other.ts",
        "lib/shared/persistence/list-attachment-uploads.ts",
      ],
      read: () => "",
    };
    expect(twinsOf(tree, "lib/attachment-uploads/persistence/list-attachment-uploads.ts")).toEqual([
      "lib/media-uploads/persistence/list-media-uploads.ts",
    ]);
  });
});

describe("comment", () => {
  const report: Report = {
    files: 2,
    tests: 1,
    context: 3,
    floor: 0.2,
    perConcern: 3,
    matrix: [
      {
        path: "src/a.ts",
        cut: false,
        tier: "deep",
        cells: { correctness: 0.12, security: 0.83, reliability: 0.2, compatibility: 0.31, testGap: 0.44 },
        probes: { security: 0.83 },
        windows: [],
      },
      {
        path: "src/b.ts",
        cut: true,
        tier: "skim",
        cells: { correctness: 0.9, security: 0.1, reliability: 0.1, compatibility: 0.1, testGap: 0.8 },
        probes: { correctness: 0.9 },
        windows: [],
      },
    ],
    profiles: [{ path: "src/a.ts", category: "behavior", priority: 2.2 }],
    inspected: [
      { path: "src/a.ts", dimension: "security", probe: "security", probability: 0.83 },
      { path: "src/b.ts", dimension: "correctness", probe: "correctness", probability: 0.9 },
    ],
    connections: [
      {
        path: "src/a.ts",
        tier: "deep",
        excerpts: [{ path: "src/lib/helper.ts", role: "imported", text: "// line 6\nexport function helper() {}" }],
      },
      { path: "src/b.ts", tier: "skim", excerpts: [] },
    ],
    findings: [
      {
        path: "src/a.ts",
        line: 42,
        dimension: "security",
        probe: "security",
        probability: 0.83,
        mechanism: "injection",
        severity: 2.4,
        owner: "security",
      },
      {
        path: "src/a.ts",
        line: 42,
        dimension: "correctness",
        probe: "correctness",
        probability: 0.12,
        mechanism: "dataFlow",
        severity: 1.1,
        owner: null,
      },
    ],
    funnel: { cells: 10, inspected: 2, located: 2, routed: 1 },
  };

  test("writes the counts and names the files to read closely, and no screening numbers", () => {
    const said = comment(report, "`abc1234`");
    expect(said).toContain("## Jev pass on `abc1234`");
    expect(said).toContain("| 2 | 1 | 2 | 2 |");
    expect(said).toContain("### Read closely\n\n- `src/a.ts`");
    expect(said).toContain("10 cells across 2 files with 3 related files as context");
    expect(said).not.toContain("0.83");
    expect(said).not.toContain("Matrix");
  });

  test("puts every concern that landed on one line in one row, under the most severe", () => {
    const said = comment(report, "`abc1234`");
    expect(said).toContain(
      "| `src/a.ts:42` | Security: injection; Correctness: data flow | 2.4 / 3 | Security |",
    );
    expect(said.match(/`src\/a\.ts:42`/g)).toHaveLength(1);
  });

  test("names a file a signal pointed at where no hunk carried the evidence", () => {
    const said = comment(report, "`abc1234`");
    expect(said).toContain("### Suspected, not located");
    expect(said).toContain("- `src/b.ts`");
  });

  test("says when no finding held up", () => {
    const said = comment({ ...report, findings: [] }, "the working tree");
    expect(said).toContain("No signal held up to the evidence in its hunks.");
  });

  test("orders the deep files by rank, gives the first whole, and names the suspected lines", () => {
    const ranked = {
      ...report,
      matrix: [
        { ...report.matrix[0]!, rank: 1.2, windows: [{ probe: "staleCache", line: 42, probability: 0.61 }, { probe: "testGap", line: 42, probability: 0.9 }] },
        { ...report.matrix[1]!, tier: "deep" as const, rank: 4.5, windows: [{ probe: "parity", line: 7, probability: 0.2 }, { probe: "parity", line: 9, probability: 0.45 }] },
        { path: "src/c.css", cut: false, tier: "ignore" as const, cells: report.matrix[0]!.cells, probes: {}, windows: [] },
      ],
    };
    const said = reading(ranked, (file) => (file === "src/b.ts" ? "export const b = 1;" : undefined));
    expect(said.indexOf("src/b.ts")).toBeLessThan(said.indexOf("src/a.ts"));
    expect(said).toContain("## Read whole\n\n- `src/b.ts`");
    expect(said).toContain("## Read from the diff\n\n- `src/a.ts`: line 42, a write that leaves a view stale");
    expect(said).not.toContain("line 7");
    expect(said).not.toContain("line 9");
    expect(said).toContain("## Leave to the build\n\n- `src/c.css`");
    expect(said).toContain("## src/b.ts\n\n```\nexport const b = 1;\n```");
    expect(said).toContain("a place to look, not a finding");
  });
});

describe("diffFor", () => {
  const block = (path: string, lines: number): string =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+line ${i} of ${path} padded to make the patch long enough to cut`).join("\n")}\n`;
  const diff =
    block("src/deep.ts", 3) + block("src/skim.ts", 80) + block("src/deep.test.ts", 80) + block("src/gen.css", 2) + block("bun.lock", 2);
  const report = {
    matrix: [
      { path: "src/deep.ts", tier: "deep" },
      { path: "src/skim.ts", tier: "skim" },
      { path: "src/gen.css", tier: "ignore" },
    ],
  } as unknown as Report;

  test("carries deep files whole, cuts skim and test files, and names what the build checks", () => {
    const said = diffFor(report, diff);
    expect(said).toContain("+line 2 of src/deep.ts");
    expect(said).toContain("+line 0 of src/skim.ts");
    expect(said).not.toContain("+line 79 of src/skim.ts");
    expect(said).toContain("+line 0 of src/deep.test.ts");
    expect(said).not.toContain("+line 79 of src/deep.test.ts");
    expect(said).toMatch(/\.\.\. \d+ more lines cut, open the file for the rest/);
    expect(said).not.toContain("+line 0 of src/gen.css");
    expect(said).not.toContain("+line 0 of bun.lock");
    expect(said).toContain("Not shown, left to the build: `src/gen.css`, `bun.lock`");
  });

  test("without a report the whole diff goes", () => {
    expect(diffFor(null, diff)).toBe(diff);
  });
});

describe("codeAt", () => {
  const tree: Tree = {
    files: ["src/a.ts"],
    read: (file) => (file === "src/a.ts" ? Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") : undefined),
  };

  const big: Tree = {
    files: ["src/big.ts"],
    read: () => Array.from({ length: 4000 }, (_, index) => `line ${index + 1} ${"x".repeat(40)}`).join("\n"),
  };

  test("sends a small file whole, so a claim about ordering or scope can be seen", () => {
    const said = codeAt(tree, "src/a.ts:30") ?? "";
    expect(said).toContain("// src/a.ts, whole, from line 1");
    expect(said).toContain("\nline 1\n");
    expect(said).toContain("line 60");
  });

  test("centres a wide window on the claim's line when the file is too big to send whole", () => {
    const said = codeAt(big, "src/big.ts:2000", 10) ?? "";
    expect(said).toContain("// src/big.ts, from line 1995 of 4000");
    expect(said).toContain("line 2000 ");
    expect(said.split("\n")).toHaveLength(11);
  });

  test("starts at the top when the claim names no line, and gives up on a file the tree lacks", () => {
    expect(codeAt(big, "src/big.ts", 4)).toContain("from line 1 of 4000");
    expect(codeAt(tree, "src/gone.ts:3")).toBeUndefined();
  });
});
