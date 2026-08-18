import { workflow } from "penguin";
import { z } from "zod";
import openPr from "./open-pr.ts";
import work from "./work.ts";

export default workflow({
  description: "ticket to open pull request: triage splits the ticket, then plan and implement per task in a worktree, then the pull request",
  params: z.object({
    ticket: z.string(),
    rounds: z.number().int().min(1).default(3),
  }),

  async run(ctx) {
    const worked = await work(ctx, { ticket: ctx.params.ticket, rounds: ctx.params.rounds });
    if (!worked.done) return { url: "" };
    return openPr(ctx, { dir: worked.path });
  },
});
