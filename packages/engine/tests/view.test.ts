import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { createTerminal, type View } from "../examples/adapters/view.ts";

function terminal(): { view: View; input: PassThrough; text: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let seen = "";
  output.on("data", (chunk: Buffer) => {
    seen += chunk.toString();
  });
  return { view: createTerminal(input, output), input, text: () => seen };
}

test("ask resolves with the raw line when no shape is given", async () => {
  const { view, input } = terminal();
  const answer = view.ask("name?");
  input.write("pip\n");
  expect(await answer).toBe("pip");
});

test("a typed ask rejects what does not fit and asks again", async () => {
  const { view, input, text } = terminal();
  const answer = view.ask("pick", z.enum(["a", "b"]));
  input.write("zzz\n");
  input.write("a\n");
  expect(await answer).toBe("a");
  expect(text()).toContain("does not fit");
});

test("a typed ask parses JSON answers into shaped values", async () => {
  const { view, input } = terminal();
  const answer = view.ask("how many?", z.number());
  input.write("4\n");
  expect(await answer).toBe(4);
});

test("parallel asks answer in order, one at a time", async () => {
  const { view, input } = terminal();
  const first = view.ask("one?");
  const second = view.ask("two?");
  input.write("1\n2\n");
  expect(await first).toBe("1");
  expect(await second).toBe("2");
});

test("listen hears lines no ask claimed", async () => {
  const { view, input } = terminal();
  const messages = view.listen()[Symbol.asyncIterator]();
  const waiting = messages.next();
  input.write("hello there\n");
  expect((await waiting).value).toEqual({ text: "hello there" });
  await messages.return?.(undefined);
});

test("a pending ask takes the line, listeners get the rest", async () => {
  const { view, input } = terminal();
  const messages = view.listen()[Symbol.asyncIterator]();
  const answer = view.ask("name?");
  input.write("pip\n");
  expect(await answer).toBe("pip");
  const waiting = messages.next();
  input.write("after\n");
  expect((await waiting).value).toEqual({ text: "after" });
  await messages.return?.(undefined);
});

test("scope prefixes shows and questions with the path", async () => {
  const { view, input, text } = terminal();
  await view.scope("a").scope("b").show("hi");
  expect(text()).toContain("[a/b] hi");
  const answer = view.scope("web").ask("deploy?");
  input.write("yes\n");
  expect(await answer).toBe("yes");
  expect(text()).toContain("? [web] deploy?");
});
