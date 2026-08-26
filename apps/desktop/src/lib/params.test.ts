import { expect, test } from "bun:test";

import type { Attachment } from "@/lib/attachments";
import { canAttach, fill, freeform, initialValues, paramsOf, withAttachments } from "@/lib/params";
import type { Control, Param } from "@/lib/params";

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return { type: "object", properties, required };
}

function only(properties: Record<string, unknown>, required: string[] = []): Param {
  const params = paramsOf(schema(properties, required));
  const param = params[0];
  if (param === undefined) throw new Error("the schema showed no param");
  return param;
}

test("a string with no multiline key stays a single-line text box", () => {
  expect(only({ ticket: { type: "string", description: "a ticket" } }).control).toEqual({
    kind: "text",
  });
});

test("only multiline true selects prose", () => {
  expect(only({ ticket: { type: "string", multiline: true } }).control).toEqual({ kind: "prose" });
  for (const marker of [false, "true", 1]) {
    expect(only({ ticket: { type: "string", multiline: marker } }).control).toEqual({
      kind: "text",
    });
  }
});

test("the marker never changes a non-string param", () => {
  expect(only({ rounds: { type: "number", multiline: true } }).control).toEqual({ kind: "number" });
  expect(only({ force: { type: "boolean", multiline: true } }).control).toEqual({
    kind: "boolean",
  });
  const tasks = only({ tasks: { type: "array", items: { type: "string" }, multiline: true } });
  expect(tasks.control).toEqual({ kind: "lines" });
});

test("enum wins over the marker", () => {
  const scope = only({ scope: { type: "string", enum: ["project", "home"], multiline: true } });
  expect(scope.control).toEqual({ kind: "choice", choices: ["project", "home"] });
});

test("internal wins over the marker", () => {
  expect(paramsOf(schema({ context: { type: "string", internal: true, multiline: true } }))).toEqual(
    [],
  );
});

test("a marked param opens with its default verbatim", () => {
  const param = only({ ticket: { type: "string", multiline: true, default: "line one\nline two" } });
  expect(param.initial).toBe("line one\nline two");
  expect(initialValues([param])).toEqual({ ticket: "line one\nline two" });
});

test("prose takes attachments ahead of the typed body, newlines intact", () => {
  const param = only({ ticket: { type: "string", multiline: true } });
  expect(canAttach(param.control)).toBe(true);
  const file: Attachment = { path: "/work/shot.png", name: "shot.png", thumbnail: undefined };
  expect(withAttachments([param], { ticket: "line one\nline two" }, { ticket: [file] })).toEqual({
    ticket: "/work/shot.png\nline one\nline two",
  });
});

test("a required prose param that is blank needs a value", () => {
  const param = only({ ticket: { type: "string", multiline: true } }, ["ticket"]);
  expect(fill([param], { ticket: "  \n " })).toEqual({ problems: { ticket: "needs a value" } });
});

test("a prose value fills as one trimmed string", () => {
  const param = only({ ticket: { type: "string", multiline: true } });
  expect(fill([param], { ticket: "\nline one\n\nline two\n" })).toEqual({
    params: { ticket: "line one\n\nline two" },
  });
});

test("prose is the only control a keyboard may correct", () => {
  expect(freeform({ kind: "prose" })).toBe(true);
  const rest: Control[] = [
    { kind: "text" },
    { kind: "number" },
    { kind: "lines" },
    { kind: "json" },
    { kind: "boolean" },
    { kind: "choice", choices: ["one"] },
  ];
  for (const control of rest) {
    expect(freeform(control)).toBe(false);
  }
});
