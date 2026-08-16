import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ask } from "../src/ask.ts";

type Terminal = {
  input: PassThrough;
  written: () => string;
  restore: () => void;
};

function terminal(isTTY: boolean): Terminal {
  const input = new PassThrough();
  Object.assign(input, { isTTY });
  const stdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", { value: input, configurable: true });
  const write = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  return {
    input,
    written: () => chunks.join(""),
    restore: () => {
      process.stdout.write = write;
      if (stdin !== undefined) Object.defineProperty(process, "stdin", stdin);
    },
  };
}

test("a gate on a terminal prints the question and reads one line", async () => {
  const box = terminal(true);
  try {
    const answered = ask("Approve the plan? (approve / revise)");
    box.input.write("  approve  \n");
    assert.equal(await answered, "approve");
    assert.match(box.written(), /gate: Approve the plan\? \(approve \/ revise\)/);
  } finally {
    box.restore();
  }
});

test("a gate with an empty answer parks", async () => {
  const box = terminal(true);
  try {
    const answered = ask("keep going?");
    box.input.write("\n");
    assert.equal(await answered, undefined);
  } finally {
    box.restore();
  }
});

test("a gate with no terminal prints the question and parks", async () => {
  const box = terminal(false);
  try {
    assert.equal(await ask("keep going?"), undefined);
    assert.match(box.written(), /gate: keep going\?/);
  } finally {
    box.restore();
  }
});
