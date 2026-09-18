import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Ctx } from "penguin";
import { NOTES_ASK, notesApprove, notesRevision, proposal } from "../examples/helpers/brief.ts";

/**
 * What the proposal page's Copy notes button writes. The renderer builds the header as
 * `'## Notes from ' + JSON.stringify(title) + ' v2'` and each row as `'- ' + id + '. ' + parts`.
 */
function block(body: string): string {
  return `---\n## Notes from "the plan" v2\n${body}\n---`;
}

/** The same block with no list markers and no version on the header. */
function bare(body: string): string {
  return `---\n## Notes from "the plan"\n${body}\n---`;
}

test("the ask tells the person where the page is and how to answer it", () => {
  expect(NOTES_ASK).toContain("Copy notes");
  expect(NOTES_ASK).toContain("approve");
  expect(NOTES_ASK).toContain("revision");
});

test("approve approves, on its own or inside the block the page copies", () => {
  expect(notesApprove("approve")).toBe(true);
  expect(notesApprove("  approve\n")).toBe(true);
});

test("an untouched page approves", () => {
  expect(notesApprove(block("No notes, all approved"))).toBe(true);
  expect(notesApprove("No notes, all approved")).toBe(true);
});

test("a block whose every number is bare or ok approves", () => {
  expect(notesApprove(block("- 3.\n- 5. ok\n- 7. OK"))).toBe(true);
  expect(notesApprove(block("Other:"))).toBe(true);
  expect(notesApprove(block(""))).toBe(true);
});

test("a block whose numbers carry no bullet reads the same way", () => {
  expect(notesApprove(bare("3.\n5. ok"))).toBe(true);
  expect(notesApprove(bare("3. a"))).toBe(false);
  expect(notesRevision(bare("3. a"))).toBe("3. a");
});

test("a number with a pick or a change does not approve", () => {
  expect(notesApprove(block("- 3. a"))).toBe(false);
  expect(notesApprove(block("- 3.\n- 5. use the existing helper instead"))).toBe(false);
  expect(notesApprove(block("Other: name it something else"))).toBe(false);
});

test("free text is a revision, whatever it says", () => {
  expect(notesApprove("keep the migration out of it")).toBe(false);
  expect(notesApprove("looks good to me")).toBe(false);
});

test("a fence in free text is a rule the person typed, not the page's block", () => {
  expect(notesApprove("drop the migration\n---\nand rename the helper")).toBe(false);
  expect(notesApprove("```\nkeep it as it is\n```")).toBe(false);
});

test("a sentence beside the pasted block is a revision, block and all", () => {
  const answer = `${block("No notes, all approved")}\nActually hold on, drop P3.`;
  expect(notesApprove(answer)).toBe(false);
  expect(notesRevision(answer)).toBe("Actually hold on, drop P3.");
});

test("one number is enough to read either way", () => {
  expect(notesApprove(block("- 4. ok"))).toBe(true);
  expect(notesApprove(block("- 4. b"))).toBe(false);
  expect(notesRevision(block("- 4. b"))).toBe("- 4. b");
});

test("a brief that never renders leaves no page from the brief before it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-brief-helper-"));
  const json = path.join(dir, "proposal.json");
  for (const ext of [".html", ".md", ".png"]) {
    fs.writeFileSync(path.join(dir, `proposal${ext}`), "the brief before this one");
  }
  const ctx = {
    agent: {
      turn: () => ({
        output: (async function* () {})(),
        value: Promise.resolve({}),
      }),
    },
    brief: {
      where: () => Promise.resolve(json),
      render: () =>
        Promise.resolve({ html: "", md: "", png: null, version: 0, problems: ["title: missing"] }),
      open: () => Promise.resolve(),
    },
    view: { show: () => Promise.resolve(), act: () => Promise.resolve() },
  } as unknown as Ctx<unknown>;

  const page = await proposal(ctx, "session-1", { about: "the plan" });

  expect(page).toBeNull();
  expect(fs.readdirSync(dir)).toEqual([]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the revision drops the fences and the header, and keeps every line of notes", () => {
  expect(notesRevision(block("- 3. a\n- 5. use the existing helper instead"))).toBe(
    "- 3. a\n- 5. use the existing helper instead",
  );
  expect(notesRevision("keep the migration out of it")).toBe("keep the migration out of it");
});
