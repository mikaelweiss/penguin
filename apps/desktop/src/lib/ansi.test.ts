import { expect, test } from "bun:test";

import { plain } from "@/lib/ansi";

const ESC = String.fromCharCode(27);

test("drops colour codes and keeps the text they wrapped", () => {
  expect(plain(`${ESC}[90mstderr${ESC}[2m | app router${ESC}[22m`)).toBe("stderr | app router");
});

test("leaves a bracket that meant itself", () => {
  expect(plain("[mp-bff] path=compatibility")).toBe("[mp-bff] path=compatibility");
});

test("drops a stray escape the sequences did not carry", () => {
  expect(plain(`done${ESC}`)).toBe("done");
});

test("drops a carriage return and keeps the tabs and newlines", () => {
  expect(plain("one\r\ntwo\tthree")).toBe("one\ntwo\tthree");
});
