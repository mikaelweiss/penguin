import { workflow } from "penguin";
import { z } from "zod";
import baseline from "./baseline.ts";
import commit from "./commit.ts";
import implement from "./implement.ts";
import plan from "./plan.ts";
import triage from "./triage.ts";

const Ack = z.union([z.enum(["ok"]), z.string()]);

function slug(ticket: string): string {
  const cut = ticket.trim().replaceAll(/[^A-Za-z0-9]+/g, "-").slice(0, 40);
  const trimmed = cut.replaceAll(/^-+|-+$/g, "");
  return trimmed === "" ? "work" : trimmed;
}

export default workflow({
  description: "triage a ticket, then plan and implement each task in a worktree",
  params: z.object({
    ticket: z.string(),
    rounds: z.number().int().min(1).default(3),
  }),

  async run(ctx) {
    const { params, vcs, view, gate } = ctx;
    const nothing = { done: false, path: "", branch: "", acceptance: "", gates: "", base: "" };

    const triaged = await triage(ctx, { ticket: params.ticket });
    if (!triaged.actionable) {
      await gate(`Not actionable: ${triaged.reason}`, Ack);
      return nothing;
    }

    const branch = `penguin-${slug(params.ticket)}`;
    const ws = await vcs.worktree.add(branch);
    if (!ws.ok) {
      await gate(`No worktree: ${ws.reason}`, Ack);
      return nothing;
    }
    view.watch({ elapsed: true, diff: ws.path });

    // The fresh worktree is the base, so what the gates say here is what every review compares against.
    const head = await vcs.head({ cwd: ws.path });
    const before = await baseline(ctx, { dir: ws.path });

    const checks: string[] = [];
    const total = triaged.tasks.length;
    for (const [index, task] of triaged.tasks.entries()) {
      await view.activity(`task ${index + 1} of ${total}`, async () => {
        const planned = await plan(ctx, { ticket: task, dir: ws.path, context: triaged.context });
        checks.push(planned.acceptance);
        const built = await implement(ctx, {
          task: planned.plan,
          acceptance: planned.acceptance,
          dir: ws.path,
          baseline: before.gates,
          base: head.sha,
          rounds: params.rounds,
        });
        if (!built.approved)
          await gate(
            `The review did not approve the change:\n\n${built.blocking}\n\nTake a look.`,
            Ack,
          );
        await commit(ctx, { dir: ws.path });
      });
    }

    return {
      done: true,
      path: ws.path,
      branch,
      acceptance: checks.join("\n\n"),
      gates: before.gates,
      base: head.sha,
    };
  },
});
