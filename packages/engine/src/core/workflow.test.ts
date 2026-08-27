import { expect, test } from "bun:test";
import { z } from "zod";
import { PenguinError, RunStopped } from "./errors.ts";
import { call, RUN, workflow, type Ctx } from "./workflow.ts";

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

function ctxWith(
  answers: string[],
  spawn: () => Promise<unknown>,
): { ctx: unknown; asked: string[] } {
  const asked: string[] = [];
  const ctx = {
    params: {},
    view: {
      ask: (question: string) => {
        asked.push(question);
        return Promise.resolve(answers[asked.length - 1] ?? "stop");
      },
    },
    [RUN]: { spawn },
  };
  return { ctx, asked };
}

const child = workflow({
  description: "a child",
  params: z.object({}),
  async run() {
    return "done";
  },
});

test("a child that died runs again when the person says so", async () => {
  let tries = 0;
  const { ctx, asked } = ctxWith(["again"], () => {
    tries += 1;
    return tries === 1
      ? Promise.reject(new PenguinError("commit.ts died with 1"))
      : Promise.resolve("done");
  });

  expect(await call(ctx as Ctx<unknown>, child, {})).toBe("done");
  expect(tries).toBe(2);
  expect(asked[0]).toContain("commit.ts died with 1");
});

test("a child that died ends the run only when the person says stop", async () => {
  let tries = 0;
  const { ctx, asked } = ctxWith(["stop"], () => {
    tries += 1;
    return Promise.reject(new PenguinError("commit.ts died with 1"));
  });

  await expect(call(ctx as Ctx<unknown>, child, {})).rejects.toThrow("commit.ts died with 1");
  expect(tries).toBe(1);
  expect(asked).toHaveLength(1);
});

test("a person stopping the child stops the run that called it", async () => {
  const { ctx, asked } = ctxWith(["again"], () =>
    Promise.reject(new RunStopped("child was stopped")),
  );

  await expect(call(ctx as Ctx<unknown>, child, {})).rejects.toThrow("child was stopped");
  expect(asked).toHaveLength(0);
});
