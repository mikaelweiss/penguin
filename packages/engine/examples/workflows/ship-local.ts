import { call, workflow } from "penguin";
import { z } from "zod";
import commit from "./commit.ts";
import implement from "./implement.ts";
import land from "./land.ts";
import work from "./work.ts";

function title(message: string): string {
  return message.split("\n")[0] ?? "";
}

export default workflow({
  description:
    "ticket to a landed commit: triage, plan, and implement in a worktree, then hold until you land it on main",
  params: z.object({
    ticket: z.string(),
    onto: z.string().default("main"),
    rounds: z.number().int().min(1).default(3),
  }),

  async run(ctx) {
    const { params, view } = ctx;
    const worked = await call(ctx, work, { ticket: params.ticket, rounds: params.rounds });
    if (!worked.done) return { landed: false, sha: "", reason: "the work never started" };

    for (;;) {
      const written = await call(ctx, commit, { dir: worked.path });
      const state = written.committed
        ? `committed: ${title(written.message)}`
        : "the tree was committed already";
      const answer = await view.ask(
        `${worked.branch} is ready in ${worked.path}\n${state}\n\nLand it on ${params.onto}?`,
        z.union([z.enum(["done"]), z.string()]),
      );
      if (answer === "done") break;
      await call(ctx, implement, {
        task: answer,
        acceptance: worked.acceptance,
        dir: worked.path,
        baseline: worked.gates,
        base: worked.base,
        rounds: params.rounds,
      });
    }

    return call(ctx, land, { branch: worked.branch, dir: worked.path, onto: params.onto });
  },
});
