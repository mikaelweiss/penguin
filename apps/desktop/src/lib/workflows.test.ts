import { expect, test } from "bun:test";

import { shelves } from "@/lib/workflows";
import type { Scope, Workflow } from "@/lib/workflows";

function workflow(name: string, scope: Scope, worktree?: string): Workflow {
  const file = `/${scope}/${name}.ts`;
  return worktree === undefined ? { name, scope, file } : { name, scope, file, worktree };
}

test("shelves the catalogs nearest first, empty ones left out", () => {
  const found = shelves([workflow("hello", "builtin"), workflow("ship", "project")]);
  expect(found.map((shelf) => shelf.scope)).toEqual(["project", "builtin"]);
});

test("worktree workflows get their own shelf, after starter and before builtin", () => {
  const found = shelves([
    workflow("hello", "builtin"),
    workflow("ship", "worktree", "feature"),
    workflow("greet", "starter"),
  ]);
  expect(found.map((shelf) => shelf.scope)).toEqual(["starter", "worktree", "builtin"]);
  expect(found[1]?.title).toBe("worktrees");
  expect(found[1]?.workflows[0]?.worktree).toBe("feature");
});
