import { call, workflow } from "penguin";
import { z } from "zod";
import commit from "./commit.ts";
import implement from "./implement.ts";
import land from "./land.ts";
import rebase from "./rebase.ts";
import work from "./work.ts";

function title(message: string): string {
  return message.split("\n")[0] ?? "";
}

export default workflow({
  description:
    "ticket to a landed commit: triage, plan, and implement in a worktree, then hold until you land it on main",
  params: z.object({
    ticket: z
      .string()
      .describe("the ticket to work, as an id, a url, or the text itself")
      .meta({ multiline: true }),
    onto: z.string().default("main").describe("the branch the work lands on"),
    rounds: z
      .number()
      .int()
      .min(1)
      .default(3)
      .describe("how many times the reviewer sends a change back before the run gives up"),
  }),

  async run(ctx) {
    const { params, view } = ctx;
    const worked = await call(ctx, work, {
      ticket: params.ticket,
      base: params.onto,
      rounds: params.rounds,
    });
    if (!worked.done) return { landed: false, sha: "", reason: "the work never started" };

    // The hold is where the person tries the code, so they try it as it will land.
    const rebased = await call(ctx, rebase, { base: params.onto, dir: worked.path });
    if (!rebased.rebased) return { landed: false, sha: "", reason: rebased.reason };

    for (;;) {
      const written = await call(ctx, commit, {}, { cwd: worked.path });
      const state = written.committed
        ? `committed: ${title(written.message)}`
        : "the tree was committed already";
      const answer = await view.ask(
        `${worked.branch} is ready in ${worked.path}\n${state}\n\nLand it on ${params.onto}?`,
        z.union([z.enum(["done"]), z.string()]),
      );
      if (answer === "done") break;
      await call(
        ctx,
        implement,
        {
          task: answer,
          acceptance: worked.acceptance,
          baseline: worked.gates,
          base: worked.from,
          rounds: params.rounds,
        },
        { cwd: worked.path },
      );
    }

    return call(ctx, land, { branch: worked.branch, dir: worked.path, onto: params.onto });
  },
});
