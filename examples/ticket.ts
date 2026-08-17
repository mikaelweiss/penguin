import { workflow } from "penguin";
import { z } from "zod";
import implement from "./implement.ts";
import plan from "./plan.ts";
import pr from "./pr.ts";
import triage from "./triage.ts";

export default workflow({
  description: "ticket to merged PR: triage splits the ticket, then plan, implement, review per task, then the pull request",
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

    const total = triaged.tasks.length;
    for (const [index, task] of triaged.tasks.entries()) {
      await view.activity(`task ${index + 1} of ${total}`, async () => {
        const planned = await plan(ctx, { ticket: task, dir: ws.path });
        const built = await implement(ctx, {
          task: planned.plan,
          acceptance: planned.acceptance,
          dir: ws.path,
        });
        if (!built.approved) await gate("The review did not approve the change. Take a look.");
      });
    }

    return pr(ctx, { dir: ws.path });
  },
});
