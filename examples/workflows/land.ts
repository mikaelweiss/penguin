import { workflow } from "penguin";
import { z } from "zod";

const Ack = z.union([z.enum(["ok"]), z.string()]);
const Resolved = z.object({
  resolved: z.boolean(),
  notes: z.string().describe("what the conflict was, and what is left when it is not resolved"),
});

function listed(files: string[]): string {
  return files.map((file) => `- ${file}`).join("\n");
}

export default workflow({
  description: "rebase a branch onto main until it is clean, then move main to it",
  params: z.object({
    branch: z.string(),
    dir: z.string().optional(),
    onto: z.string().default("main"),
    passes: z.number().int().min(1).default(3),
    resolutions: z.number().int().min(1).default(10),
  }),

  async run({ params, agent, vcs, view, gate }) {
    const cwd = params.dir;
    const nowhere = (reason: string) => ({ landed: false, sha: "", reason });
    let turns = 0;
    let clean = false;

    const checkout = await vcs.head();
    if (checkout.branch !== params.onto) {
      await gate(`The checkout is on ${checkout.branch}, not ${params.onto}. Switch it.`, Ack);
      return nowhere(`the checkout is on ${checkout.branch}`);
    }

    for (let pass = 1; pass <= params.passes && !clean; pass++) {
      view.fact({ pass: `${pass}/${params.passes}` });
      const fetched = await vcs.fetch(params.onto, { cwd });
      if (!fetched.ok) {
        await gate(`The fetch of ${params.onto} failed: ${fetched.reason}`, Ack);
        return nowhere(fetched.reason);
      }

      // The branch rebases onto the local target, so the target carries what origin just sent.
      const advanced = await vcs.merge(`origin/${params.onto}`, { ffOnly: true });
      if (!advanced.ok) {
        await gate(
          `${params.onto} and origin/${params.onto} have diverged: ${advanced.reason}\n\nReconcile them.`,
          Ack,
        );
        return nowhere(advanced.reason);
      }

      let state = await vcs.rebase.onto(params.onto, { cwd });
      const conflicted = state.conflicted;
      while (state.conflicted) {
        if (turns === params.resolutions) {
          await gate(
            `${params.resolutions} conflict resolutions, and the rebase is still open. Finish it yourself.`,
            Ack,
          );
          return nowhere("the resolution bound ran out");
        }
        turns += 1;
        view.fact({ conflicts: state.files.length });
        const fixer = agent({ cwd });
        const fixed = (await fixer.run("penguin-resolve-conflicts", {
          input: `The rebase onto ${params.onto} stopped on these files:\n\n${listed(state.files)}`,
          result: Resolved,
        }))!;
        if (!fixed.resolved) {
          const answer = await gate(
            `The conflicts are still open: ${fixed.notes}\n\nFix them and stage the files, or drop the rebase.`,
            z.union([z.enum(["continue", "abort"]), z.string()]),
          );
          if (answer === "abort") {
            await vcs.rebase.abort({ cwd });
            return nowhere("the user dropped the rebase");
          }
        }
        state = await vcs.rebase.continue({ cwd });
      }

      if (!state.ok) {
        await gate(`The rebase onto ${params.onto} failed: ${state.reason}`, Ack);
        return nowhere(state.reason);
      }
      clean = !conflicted;
    }

    if (!clean) {
      await gate(`${params.passes} rebase passes, and ${params.onto} keeps moving. Take a look.`, Ack);
      return nowhere("the pass bound ran out");
    }

    const merged = await vcs.merge(params.branch, { ffOnly: true });
    if (!merged.ok) {
      await gate(`${params.onto} did not fast-forward to ${params.branch}: ${merged.reason}`, Ack);
      return nowhere(merged.reason);
    }

    const landed = await vcs.head();
    view.fact({ landed: `${params.onto} ${landed.sha}` });
    view.event({ message: `${params.branch} is on ${params.onto} at ${landed.sha}` });

    if (cwd !== undefined) {
      const removed = await vcs.worktree.remove(cwd);
      if (!removed.ok) {
        await gate(
          `${params.branch} is on ${params.onto}, but the worktree at ${cwd} stayed: ${removed.reason}\n\nRemove it yourself.`,
          Ack,
        );
      }
    }

    return { landed: true, sha: landed.sha, reason: "" };
  },
});
