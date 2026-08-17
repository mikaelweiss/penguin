import { workflow } from "penguin";
import { z } from "zod";
import implement from "./implement.ts";
import plan from "./plan.ts";
import pr from "./pr.ts";
import triage from "./triage.ts";

export default workflow({
  description: "ticket to merged PR: triage, plan, implement, review, then the pull request",
  params: z.object({ ticket: z.string() }),

  async run(ctx) {
    const { params, vcs, view, gate } = ctx;
    const triaged = await triage(ctx, { ticket: params.ticket });
    if (!triaged.actionable) {
      await gate(`Not actionable: ${triaged.reason}`);
      return;
    }

    const ws = await vcs.worktree.add(`penguin-${params.ticket}`);
    if (!ws.ok) {
      await gate(`No worktree: ${ws.reason}`);
      return;
    }
    view.watch({ elapsed: true, diff: ws.path });

    const planned = await plan(ctx, { ticket: params.ticket, dir: ws.path });

    const built = await implement(ctx, {
      task: planned.spec,
      acceptance: planned.acceptance,
      dir: ws.path,
    });
    if (!built.approved) await gate("The review did not approve the change. Take a look.");

    return pr(ctx, { dir: ws.path });
  },
});
