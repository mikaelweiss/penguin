import { call, workflow } from "penguin";
import { z } from "zod";
import openPr from "./open-pr.ts";
import work from "./work.ts";

export default workflow({
  description:
    "ticket to open pull request: triage splits the ticket, then plan and implement per task in a worktree, then the pull request",
  params: z.object({
    ticket: z.string().describe("the ticket to work, as an id, a url, or the text itself"),
    rounds: z
      .number()
      .int()
      .min(1)
      .default(3)
      .describe("how many times the reviewer sends a change back before the run gives up"),
  }),

  async run(ctx) {
    const worked = await call(ctx, work, { ticket: ctx.params.ticket, rounds: ctx.params.rounds });
    if (!worked.done) return { url: "" };
    return call(ctx, openPr, {}, { cwd: worked.path });
  },
});
