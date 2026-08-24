import type { Project } from "@/lib/runs";

/** Stands in for the run files under ~/.local/state/penguin/runs until the reader lands. */
export const sampleProjects: Project[] = [
  {
    id: "penguin",
    name: "penguin",
    dir: "~/code/penguin",
    runs: [
      {
        id: "r-release",
        name: "release",
        status: "running",
        dir: "~/code/penguin",
        output: [
          { kind: "show", text: "changelog drafted from 12 commits" },
          { kind: "show", text: "waiting on ship" },
        ],
        children: [
          {
            id: "r-ship",
            name: "ship",
            status: "running",
            dir: "~/.penguin/worktrees/penguin/ship",
            output: [
              { kind: "show", text: "tree is dirty" },
              { kind: "show", text: "handing off to commit" },
            ],
            children: [
              {
                id: "r-commit",
                name: "commit",
                status: "running",
                dir: "~/.penguin/worktrees/penguin/ship",
                ask: {
                  prompt: "Commit 3 files in packages/engine?",
                  choices: ["yes", "no"],
                  many: false,
                  other: false,
                },
                output: [
                  { kind: "show", text: "staged 3 files" },
                  { kind: "tool", text: "packages/engine/src/run.ts" },
                  { kind: "tool", text: "packages/engine/src/trace.ts" },
                  { kind: "tool", text: "docs/ui.html" },
                  { kind: "ask", text: "Commit 3 files in packages/engine?" },
                ],
                children: [],
              },
            ],
          },
        ],
      },
      {
        id: "r-steer",
        name: "steer",
        status: "running",
        dir: "~/code/penguin",
        output: [
          { kind: "show", text: "reading packages/engine/src/host.ts" },
          { kind: "tool", text: "Edit: src/host.ts" },
          { kind: "show", text: "the host resolves cwd before spawn now" },
          { kind: "message", text: "run the engine tests too" },
          { kind: "tool", text: "Bash: bun test host" },
          { kind: "show", text: "12 tests pass" },
        ],
        children: [],
      },
      {
        id: "r-commit-all",
        name: "commit-all",
        status: "done",
        dir: "~/code/penguin",
        output: [
          { kind: "show", text: "nothing to commit, tree is clean" },
          { kind: "tool", text: "returned { committed: false }" },
        ],
        children: [],
      },
      {
        id: "r-fix-ci",
        name: "fix-ci",
        status: "failed",
        dir: "~/code/penguin",
        output: [
          { kind: "show", text: "rerunning the failing check" },
          { kind: "tool", text: "Bash: bun test engine" },
          { kind: "show", text: "threw: the fix did not hold after two tries" },
        ],
        children: [],
      },
    ],
  },
  {
    id: "skyward",
    name: "skyward",
    dir: "~/code/skyward",
    runs: [
      {
        id: "r-sky-commit",
        name: "commit",
        status: "running",
        dir: "~/code/skyward",
        output: [
          { kind: "show", text: "staged 1 file" },
          { kind: "tool", text: "Sources/Logbook.swift" },
          { kind: "show", text: "writing commit message" },
        ],
        children: [],
      },
      {
        id: "r-sky-notes",
        name: "release-notes",
        status: "running",
        dir: "~/code/skyward",
        ask: {
          prompt: "Which sections go in the notes?",
          choices: ["features", "fixes", "docs"],
          many: true,
          other: true,
        },
        output: [
          { kind: "show", text: "34 commits since 1.4" },
          { kind: "show", text: "grouping by change type" },
          { kind: "ask", text: "Which sections go in the notes?" },
        ],
        children: [],
      },
      {
        id: "r-sky-review",
        name: "review",
        status: "done",
        dir: "~/code/skyward",
        output: [
          { kind: "show", text: "2 findings, both nits" },
          { kind: "answer", text: "no" },
          { kind: "tool", text: "returned { findings: 2 }" },
        ],
        children: [],
      },
    ],
  },
];
