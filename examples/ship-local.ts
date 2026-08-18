import { workflow } from "penguin";
import { z } from "zod";
import commit from "./commit.ts";
import implement from "./implement.ts";
import land from "./land.ts";
import work from "./work.ts";

function title(message: string): string {
  return message.split("\n")[0] ?? "";
}

export default workflow({
  description: "ticket to a landed commit: triage, plan, and implement in a worktree, then hold until you land it on main",
  params: z.object({
    ticket: z.string(),
    onto: z.string().default("main"),
    rounds: z.number().int().min(1).default(3),
  }),

  async run(ctx) {
    const { params, view, gate } = ctx;
    const worked = await work(ctx, { ticket: params.ticket, rounds: params.rounds });
    if (!worked.done) return { landed: false, sha: "", reason: "the work never started" };
    view.artifact({ title: worked.branch, path: worked.path });

    for (;;) {
      const written = await commit(ctx, { dir: worked.path });
      const state = written.committed
        ? `committed: ${title(written.message)}`
        : "the tree was committed already";
      const answer = await gate(
        `${worked.branch} is ready in ${worked.path}\n${state}\n\nType done to land it on ${params.onto}, or type what to change.`,
      );
      if (answer === "done") break;
      await implement(ctx, {
        task: answer,
        acceptance: worked.acceptance,
        dir: worked.path,
        rounds: params.rounds,
      });
    }

    return land(ctx, { branch: worked.branch, dir: worked.path, onto: params.onto });
  },
});
