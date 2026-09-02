import { expect, test } from "bun:test";
import { settledStatus, type View } from "./view.ts";

function recording(): { view: View; seen: unknown[][] } {
  const seen: unknown[][] = [];
  const view = {
    status: async (text: string, options?: unknown) => {
      seen.push([text, options]);
    },
  } as unknown as View;
  return { view, seen };
}

test("the same status twice in a row reaches the view once", async () => {
  const { view, seen } = recording();
  const settled = settledStatus(view);
  await settled.status("waiting", { idle: true });
  await settled.status("waiting", { idle: true });
  await settled.status("waiting", { idle: true });
  expect(seen).toEqual([["waiting", { idle: true }]]);
});

test("a change in text or idleness is a new status", async () => {
  const { view, seen } = recording();
  const settled = settledStatus(view);
  await settled.status("waiting");
  await settled.status("waiting", { idle: true });
  await settled.status("building");
  await settled.status("waiting");
  expect(seen.map(([text]) => text)).toEqual(["waiting", "waiting", "building", "waiting"]);
});
