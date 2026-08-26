import { expect, test } from "bun:test";
import { z } from "zod";
import { workflow } from "./workflow.ts";

test("a multiline marker survives onto the JSON Schema a form reads", () => {
  const definition = workflow({
    description: "take a ticket",
    params: z.object({
      ticket: z.string().describe("the ticket to work").meta({ multiline: true }),
    }),
    async run() {
      return undefined;
    },
  });

  const schema = z.toJSONSchema(definition.params) as {
    properties: Record<string, Record<string, unknown>>;
  };
  expect(schema.properties["ticket"]).toMatchObject({
    description: "the ticket to work",
    multiline: true,
  });
});
