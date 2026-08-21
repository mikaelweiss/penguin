import { expect, test } from "bun:test";
import { Channel } from "./channel.ts";

test("delivers pushed items in order", async () => {
  const channel = new Channel<number>();
  channel.push(1);
  channel.push(2);
  channel.end();
  const seen: number[] = [];
  for await (const item of channel) seen.push(item);
  expect(seen).toEqual([1, 2]);
});

test("wakes a consumer that was already waiting", async () => {
  const channel = new Channel<string>();
  const waiting = channel[Symbol.asyncIterator]().next();
  channel.push("hi");
  expect((await waiting).value).toBe("hi");
});

test("end releases waiting consumers as done", async () => {
  const channel = new Channel<string>();
  const waiting = channel[Symbol.asyncIterator]().next();
  channel.end();
  expect((await waiting).done).toBe(true);
});

test("items pushed before end still drain after it", async () => {
  const channel = new Channel<number>();
  channel.push(1);
  channel.end();
  const seen: number[] = [];
  for await (const item of channel) seen.push(item);
  expect(seen).toEqual([1]);
});
