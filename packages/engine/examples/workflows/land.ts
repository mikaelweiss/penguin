import { call, workflow } from "penguin";
import { z } from "zod";
import rebase from "./rebase.ts";

const Ack = z.union([z.enum(["ok"]), z.string()]);

export default workflow({
  description: "rebase a branch onto main until it is clean, then move main to it",
  params: z.object({
    branch: z.string().describe("the branch to land"),
    onto: z.string().default("main").describe("the branch it lands on"),
    /** The worktree the branch rebases in, which is not the checkout this run moves. */
    dir: z.string().optional().meta({ internal: true }),
    passes: z.number().int().min(1).default(3).meta({ internal: true }),
    resolutions: z.number().int().min(1).default(10).meta({ internal: true }),
  }),

  async run(ctx) {
    const { params, vcs, view } = ctx;
    const cwd = params.dir;
    const nowhere = (reason: string) => ({ landed: false, sha: "", reason });

    const checkout = await vcs.head();
    if (checkout.branch !== params.onto) {
      await view.ask(`The checkout is on ${checkout.branch}, not ${params.onto}. Switch it.`, Ack);
      return nowhere(`the checkout is on ${checkout.branch}`);
    }

    // The branch lands on the local target, which a run that never pushed has already moved ahead
    // of origin, so the target takes what origin sent and then the branch rebases onto the target.
    const advanced = await vcs.pull(params.onto);
    if (!advanced.ok) {
      await view.ask(
        `${params.onto} and origin/${params.onto} have diverged: ${advanced.reason}\n\nReconcile them.`,
        Ack,
      );
      return nowhere(advanced.reason);
    }

    const rebased = await call(ctx, rebase, {
      base: params.onto,
      local: true,
      dir: params.dir,
      passes: params.passes,
      resolutions: params.resolutions,
    });
    if (!rebased.rebased) return nowhere(rebased.reason);

    const merged = await vcs.merge(params.branch, { ffOnly: true });
    if (!merged.ok) {
      await view.ask(`${params.onto} did not fast-forward to ${params.branch}: ${merged.reason}`, Ack);
      return nowhere(merged.reason);
    }

    const landed = await vcs.head();
    await view.show(`${params.branch} is on ${params.onto} at ${landed.sha}`);

    if (cwd !== undefined) {
      const removed = await vcs.worktree.remove(cwd);
      if (!removed.ok) {
        await view.ask(
          `${params.branch} is on ${params.onto}, but the worktree at ${cwd} stayed: ${removed.reason}\n\nRemove it yourself.`,
          Ack,
        );
      }
    }

    return { landed: true, sha: landed.sha, reason: "" };
  },
});
