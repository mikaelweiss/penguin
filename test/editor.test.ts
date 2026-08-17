import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { ask, Editor, type Key, layout } from "../src/editor.ts";
import { coerce, parseParams, unfilled, validate } from "../src/params.ts";
import { terminal } from "./helpers.ts";

function type(editor: Editor, text: string): void {
  for (const one of text) editor.key(one, { name: one });
}

function press(editor: Editor, name: string, extra: Partial<Key> = {}): void {
  editor.key(undefined, { name, ...extra });
}

function paste(editor: Editor, text: string): void {
  editor.key(undefined, { name: "paste-start" });
  for (const one of text) {
    editor.key(one, { name: one === "\n" ? "enter" : one, sequence: one });
  }
  editor.key(undefined, { name: "paste-end" });
}

test("typed characters insert at the cursor", () => {
  const editor = new Editor();
  type(editor, "hello");
  press(editor, "left");
  press(editor, "left");
  type(editor, "-");
  assert.equal(editor.shown.text, "hel-lo");
  assert.equal(editor.shown.cursor, 4);
});

test("a bracketed paste lands as one unit, newlines kept", () => {
  const editor = new Editor();
  type(editor, "see: ");
  paste(editor, "one\ntwo");
  assert.equal(editor.shown.text, "see: one\ntwo");
  assert.equal(editor.take(), "see: one\ntwo");
  assert.equal(editor.shown.text, "");
});

test("enter inside a paste never sends", () => {
  const editor = new Editor();
  editor.key(undefined, { name: "paste-start" });
  assert.equal(editor.key("\n", { name: "enter", sequence: "\n" }), "none");
  assert.equal(editor.key(undefined, { name: "paste-end" }), "changed");
  assert.equal(editor.shown.text, "\n");
});

test("a large paste collapses to a token, and take expands it", () => {
  const editor = new Editor();
  const big = Array.from({ length: 20 }, (_, n) => `line ${n}`).join("\n");
  paste(editor, big);
  assert.equal(editor.shown.text, "[pasted #1, 20 lines]");
  type(editor, " done");
  assert.equal(editor.take(), `${big} done`);
});

test("backspace removes a whole token, and the paste is forgotten", () => {
  const editor = new Editor();
  const big = Array.from({ length: 20 }, () => "x").join("\n");
  paste(editor, big);
  press(editor, "backspace");
  assert.equal(editor.shown.text, "");
  type(editor, "kept");
  assert.equal(editor.take(), "kept");
});

test("the cursor never lands inside a token", () => {
  const editor = new Editor();
  const big = Array.from({ length: 20 }, () => "x").join("\n");
  type(editor, "a ");
  paste(editor, big);
  const token = "[pasted #1, 20 lines]";
  press(editor, "left");
  assert.equal(editor.shown.cursor, 2);
  press(editor, "right");
  assert.equal(editor.shown.cursor, 2 + token.length);
});

test("ctrl-w through a token takes the whole token", () => {
  const editor = new Editor();
  const big = Array.from({ length: 20 }, () => "x").join("\n");
  paste(editor, big);
  press(editor, "w", { ctrl: true });
  assert.equal(editor.shown.text, "");
  assert.equal(editor.take(), "");
});

test("line editing: home, end, kill, word moves", () => {
  const editor = new Editor();
  type(editor, "one two three");
  press(editor, "a", { ctrl: true });
  assert.equal(editor.shown.cursor, 0);
  press(editor, "f", { meta: true });
  assert.equal(editor.shown.cursor, 3);
  press(editor, "e", { ctrl: true });
  press(editor, "b", { meta: true });
  assert.equal(editor.shown.cursor, 8);
  press(editor, "k", { ctrl: true });
  assert.equal(editor.shown.text, "one two ");
  press(editor, "u", { ctrl: true });
  assert.equal(editor.shown.text, "");
});

test("up and down recall sent messages, and the draft survives", () => {
  const editor = new Editor();
  type(editor, "first");
  editor.take();
  type(editor, "second");
  editor.take();
  type(editor, "dra");
  press(editor, "up");
  assert.equal(editor.shown.text, "second");
  press(editor, "up");
  assert.equal(editor.shown.text, "first");
  press(editor, "down");
  press(editor, "down");
  assert.equal(editor.shown.text, "dra");
});

test("escape clears, enter on empty stays quiet", () => {
  const editor = new Editor();
  type(editor, "abc");
  assert.equal(editor.key(undefined, { name: "escape" }), "changed");
  assert.equal(editor.shown.text, "");
  assert.equal(editor.key("\r", { name: "return" }), "none");
});

test("layout wraps rows and places the cursor", () => {
  const flat = layout("abcdefgh", 8, 5, "> ");
  assert.deepEqual(flat.rows, ["> abc", "defgh", ""]);
  assert.equal(flat.row, 2);
  assert.equal(flat.column, 1);

  const mid = layout("abcdefgh", 3, 5, "> ");
  assert.equal(mid.row, 1);
  assert.equal(mid.column, 1);

  const lines = layout("ab\ncd", 4, 10, "> ");
  assert.deepEqual(lines.rows, ["> ab", "cd"]);
  assert.equal(lines.row, 1);
  assert.equal(lines.column, 2);
});

test("ask takes a typed line and erases the question", async (t) => {
  const screen = terminal(t, "");
  const answered = ask("--ticket <text>", { interrupt: () => {} });
  screen.input.write("JIRA-12\r");
  assert.equal(await answered, "JIRA-12");
  assert.match(screen.text(), /--ticket <text>/);
});

test("ask resolves empty on enter with nothing typed", async (t) => {
  const screen = terminal(t, "");
  const answered = ask("--dir <text>", { notes: ["enter skips"], interrupt: () => {} });
  screen.input.write("\r");
  assert.equal(await answered, "");
  assert.match(screen.text(), /enter skips/);
});

test("interactive entry fills the same params the args fill", () => {
  const schema = z.object({
    ticket: z.string(),
    count: z.number(),
    mode: z.enum(["fast", "slow"]).optional(),
    dry: z.boolean().default(false),
  });
  const byArgs = parseParams(schema, ["--ticket", "T-1", "--count", "3", "--mode", "fast"]);

  const values: Record<string, unknown> = parseParams(schema, []);
  const open = unfilled(schema, values);
  assert.deepEqual(
    open.map((one) => one.name),
    ["ticket", "count", "mode"],
  );
  assert.equal(open.find((one) => one.name === "mode")?.optional, true);
  assert.deepEqual(open.find((one) => one.name === "mode")?.choices, ["fast", "slow"]);
  for (const [name, typed] of [
    ["ticket", "T-1"],
    ["count", "3"],
    ["mode", "fast"],
  ] as const) {
    const param = open.find((one) => one.name === name);
    assert.notEqual(param, undefined);
    values[name] = coerce(param?.kind ?? "", name, typed);
  }
  assert.deepEqual(validate(schema, values), byArgs);
});
