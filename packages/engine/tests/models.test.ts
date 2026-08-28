import { expect, test } from "bun:test";
import { modelFor } from "../examples/helpers/models.ts";

const models = {
  best: "provider-best",
  big: "provider-big",
  small: "provider-small",
};

test("neutral model choices resolve through the adapter's model map", () => {
  expect(modelFor("best", "test", models, () => undefined)).toBe("provider-best");
  expect(modelFor("big", "test", models, () => undefined)).toBe("provider-big");
  expect(modelFor("small", "test", models, () => undefined)).toBe("provider-small");
});

test("an adapter-specific config overrides a built-in neutral model", () => {
  expect(
    modelFor("big", "test", models, (key) =>
      key === "test-big-model" ? "configured-big" : undefined,
    ),
  ).toBe("configured-big");
});

test("an exact provider model passes through unchanged", () => {
  expect(modelFor("provider-special", "test", models, () => undefined)).toBe(
    "provider-special",
  );
  expect(modelFor(undefined, "test", models, () => undefined)).toBeUndefined();
});

test("an unmapped neutral choice falls back to the adapter's default model", () => {
  expect(modelFor("small", "test", {}, () => undefined)).toBeUndefined();
});
