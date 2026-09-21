import { call, workflow } from "penguin";
import { z } from "zod";
import openPr from "./open-pr.ts";
import work from "./work.ts";

export default workflow({
  description:
    "ticket to merged pull request: triage splits the ticket, then plan and implement per task in a worktree, then open the pull request and answer its feedback until it lands",
  params: z.object({
    ticket: z
      .string()
      .describe("the ticket to work, as an id, a url, or the text itself")
      .meta({ multiline: true }),
    base: z
      .string()
      .default("main")
      .describe(
        "the branch the work starts from and the pull request lands on, empty to take the one origin calls default",
      ),
    rounds: z
      .number()
      .int()
      .min(1)
      .default(3)
      .describe("how many times the reviewer sends a change back before the run gives up"),
    branch: z
      .string()
      .default("")
      .describe("the branch to carry on with, empty to let triage name a new one")
      .meta({ internal: true }),
    tasks: z
      .array(z.string())
      .default([])
      .describe("the split to work, empty to let triage make one")
      .meta({ internal: true }),
    done: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("how many of the tasks are built already")
      .meta({ internal: true }),
    acceptance: z
      .string()
      .default("")
      .describe("what the tasks already built accept on, so the pull request states all of it")
      .meta({ internal: true }),
  }),

  async run(ctx) {
    const nowhere = { url: "", state: "", rounds: 0 };
    const worked = await call(ctx, work, {
      ticket: ctx.params.ticket,
      base: ctx.params.base,
      rounds: ctx.params.rounds,
      branch: ctx.params.branch,
      tasks: ctx.params.tasks,
      done: ctx.params.done,
      acceptance: ctx.params.acceptance,
    });
    if (!worked.done) return nowhere;

    return call(ctx, openPr, { base: worked.base }, { cwd: worked.path });
  },
});
