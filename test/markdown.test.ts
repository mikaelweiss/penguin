import assert from "node:assert/strict";
import test from "node:test";
import { cut, markdown, plain, wide } from "../src/markdown.ts";

function bare(text: string, columns = 40): string[] {
  return markdown(text, columns, false);
}

test("a heading reads bold, and its hashes are gone", () => {
  assert.deepEqual(markdown("### Blockers", 40), ["\x1b[1mBlockers\x1b[22m"]);
  assert.deepEqual(bare("### Blockers"), ["Blockers"]);
});

test("a list keeps its marker, and the wrap hangs under the text", () => {
  assert.deepEqual(bare("- one two three four five six seven", 20), [
    "• one two three four",
    "  five six seven",
  ]);
  assert.deepEqual(bare("1. first\n2. second"), ["1. first", "2. second"]);
});

test("a paragraph joins its lines and wraps to the width", () => {
  const lines = bare("one two\nthree four five six seven eight nine", 20);
  assert.ok(lines.every((line) => line.length <= 20), lines.join("|"));
  assert.equal(lines.join(" "), "one two three four five six seven eight nine");
});

test("emphasis and code style the words, never the markers", () => {
  assert.deepEqual(markdown("a `pn run` **now** *soon*", 60), [
    "a \x1b[36mpn run\x1b[39m \x1b[1mnow\x1b[22m \x1b[3msoon\x1b[23m",
  ]);
  assert.deepEqual(bare("a `pn run` **now** *soon*"), ["a pn run now soon"]);
});

test("snake_case survives, because underscores are not emphasis", () => {
  assert.deepEqual(bare("call some_long_name here"), ["call some_long_name here"]);
});

test("a fenced block keeps its lines as they are", () => {
  assert.deepEqual(bare("text\n\n```\nif (a) b();\n```"), ["text", "", "  if (a) b();"]);
});

test("a blank line separates blocks, and the edges are trimmed", () => {
  assert.deepEqual(bare("\n\none\n\n\ntwo\n\n"), ["one", "", "two"]);
});

test("the width counts what the eye sees, not the style codes", () => {
  assert.equal(wide("\x1b[1mfour\x1b[22m"), 4);
  const lines = markdown("**one two three four five six seven eight**", 20);
  assert.ok(lines.every((line) => wide(line) <= 20), lines.join("|"));
});

test("a cut line ends in an ellipsis and fits the columns", () => {
  assert.equal(cut("abcdef", 4), "abc…");
  assert.equal(cut("abc", 4), "abc");
  assert.equal(wide(cut("\x1b[1mabcdef\x1b[22m", 4)), 4);
});

test("plain takes the words out of one markdown line", () => {
  assert.equal(plain("- The `strip` covers **play**"), "The strip covers play");
  assert.equal(plain("### Blockers"), "Blockers");
});
