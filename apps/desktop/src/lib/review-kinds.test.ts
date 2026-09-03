import { expect, test } from "bun:test";

import type { FileChange } from "@/lib/files";
import { filterReviewFiles, statusEntries, statusLabel } from "@/lib/review-kinds";

const FILES = ["src/App.tsx", "src/lib/Diff.ts", "docs/ui.html"];

function change(file: string, status: FileChange["status"]): FileChange {
  return { file, status, additions: 0, deletions: 0, patch: "", binary: false, truncated: false };
}

test("an empty query keeps every file", () => {
  expect(filterReviewFiles(FILES, "   ")).toEqual(FILES);
});

test("a query matches any part of the path, whatever its case", () => {
  expect(filterReviewFiles(FILES, "SRC/")).toEqual(["src/App.tsx", "src/lib/Diff.ts"]);
  expect(filterReviewFiles(FILES, "diff")).toEqual(["src/lib/Diff.ts"]);
  expect(filterReviewFiles(FILES, "missing")).toEqual([]);
});

test("each status prints its one letter badge", () => {
  expect(statusLabel("added")).toBe("A");
  expect(statusLabel("deleted")).toBe("D");
  expect(statusLabel("modified")).toBe("M");
});

test("every change becomes a tree entry keyed by its path", () => {
  expect(statusEntries([change("a.ts", "added"), change("b.ts", "deleted")])).toEqual([
    { path: "a.ts", status: "added" },
    { path: "b.ts", status: "deleted" },
  ]);
});
