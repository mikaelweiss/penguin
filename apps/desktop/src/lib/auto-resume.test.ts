import { expect, test } from "bun:test";

import { dueAt, limitPaused, RETRY_MS, SLACK_MS } from "@/lib/auto-resume";
import type { Paused, Project, Run } from "@/lib/runs";

const NOW = Date.parse("2026-09-02T16:00:00.000Z");

function paused(rest: Partial<Paused> = {}): Paused {
  return { by: "limit", at: "2026-09-02T15:30:00.000Z", ...rest };
}

test("a reset time ahead is waited for, plus a moment", () => {
  expect(dueAt(paused({ until: "2026-09-02T17:00:00.000Z" }), NOW)).toBe(
    Date.parse("2026-09-02T17:00:00.000Z") + SLACK_MS,
  );
});

test("a reset time already behind us, or none, is a retry wait from now", () => {
  expect(dueAt(paused({ until: "2026-09-02T15:00:00.000Z" }), NOW)).toBe(NOW + RETRY_MS);
  expect(dueAt(paused({ until: "2026-09-02T16:00:00.000Z" }), NOW)).toBe(NOW + RETRY_MS);
  expect(dueAt(paused(), NOW)).toBe(NOW + RETRY_MS);
  expect(dueAt(paused({ until: "soon" }), NOW)).toBe(NOW + RETRY_MS);
});

function run(id: string, status: Run["status"], held?: Paused, children: Run[] = []): Run {
  return {
    id,
    name: id,
    status,
    dir: "/work",
    cwd: "/work",
    at: "t1",
    ...(held === undefined ? {} : { paused: held }),
    listening: false,
    input: [],
    output: [],
    opens: [],
    children,
  };
}

test("only root runs a limit parked are brought back, never one an error did", () => {
  const limited = run("limited", "paused", paused());
  const inner = run("inner", "paused", paused());
  const projects: Project[] = [
    {
      id: "/work",
      name: "work",
      dir: "/work",
      runs: [
        limited,
        run("byhand", "paused", paused({ by: "user" })),
        run("broken", "paused", paused({ by: "error" })),
        run("dead", "paused", paused({ by: "interrupted" })),
        run("going", "running"),
        run("parent", "paused", paused({ by: "user" }), [inner]),
      ],
    },
  ];

  expect([...limitPaused(projects).keys()]).toEqual(["limited"]);
});
