import { workflow } from "penguin";
import { z } from "zod";
import { resolveBase } from "../helpers/base.ts";
import { narrated } from "../helpers/turns.ts";

const Ack = z.union([z.enum(["ok"]), z.string()]);
const Resolved = z.object({
  resolved: z.boolean(),
  notes: z.string().describe("what the conflict was, and what is left when it is not resolved"),
});

function listed(files: string[]): string {
  return files.map((file) => `- ${file}`).join("\n");
}

export default workflow({
  description: "rebase the worktree's branch onto its base until a pass runs clean",
  params: z.object({
    base: z
      .string()
      .default("")
      .describe("the branch it rebases onto, empty to take the one origin calls default"),
    /** The base lives only in this clone, so the branch lands on the branch and not on origin's copy. */
    local: z.boolean().default(false).meta({ internal: true }),
    /** The worktree that rebases, which is not the checkout the run started from. */
    dir: z.string().optional().meta({ internal: true }),
    passes: z.number().int().min(1).default(3).meta({ internal: true }),
    resolutions: z.number().int().min(1).default(10).meta({ internal: true }),
  }),

  async run(ctx) {
    const { params, agent, vcs, view } = ctx;
    const cwd = params.dir;
    const folder = cwd ?? "The checkout";
    const nowhere = (reason: string) => ({ rebased: false, sha: "", base: "", reason });
    let turns = 0;
    let clean = false;

    const head = await vcs.head({ cwd });
    if (!head.ok) {
      await view.ask(`${folder} did not read: ${head.reason}`, Ack);
      return nowhere(head.reason);
    }
    if (head.detached) {
      await view.ask(`${folder} is detached, so there is no branch to rebase.`, Ack);
      return nowhere("the worktree is detached");
    }
    const tree = await vcs.dirty({ cwd });
    if (tree.dirty) {
      await view.ask(`${folder} has uncommitted changes. Commit or drop them first.`, Ack);
      return nowhere("the worktree is dirty");
    }

    const base = await resolveBase(ctx, params.base);
    if (base === "") return nowhere("no base branch");
    const onto = params.local ? base : `origin/${base}`;

    for (let pass = 1; pass <= params.passes && !clean; pass++) {
      await view.show(`pass ${pass} of ${params.passes}`);
      const fetched = await vcs.fetch(base, { cwd });
      if (!fetched.ok) {
        await view.ask(`The fetch of ${base} failed: ${fetched.reason}`, Ack);
        return nowhere(fetched.reason);
      }

      let state = await vcs.rebase.onto(onto, { cwd });
      const conflicted = state.conflicted;
      while (state.conflicted) {
        if (turns === params.resolutions) {
          await view.ask(
            `${params.resolutions} conflict resolutions, and the rebase is still open. Finish it yourself.`,
            Ack,
          );
          return nowhere("the resolution bound ran out");
        }
        turns += 1;
        const fixer = await agent.open({ cwd });
        const fixed = await narrated(
          view,
          agent.turn(
            fixer,
            {
              skill: "resolve-conflicts",
              prompt: `The rebase onto ${onto} stopped on these files:\n\n${listed(state.files)}`,
            },
            { result: Resolved },
          ),
        );
        if (!fixed.resolved) {
          const answer = await view.ask(
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
        await view.ask(`The rebase onto ${onto} failed: ${state.reason}`, Ack);
        return nowhere(state.reason);
      }
      // Conflicts take time, and the base can move while they are resolved, so a pass that hit
      // any of them runs again to see what arrived.
      clean = !conflicted;
    }

    if (!clean) {
      await view.ask(`${params.passes} rebase passes, and ${base} keeps moving. Take a look.`, Ack);
      return nowhere("the pass bound ran out");
    }

    // The caller reviews the branch against what it now sits on, so the ref it landed under is pinned here.
    const landed = await vcs.sha(onto, { cwd });
    const rebased = await vcs.head({ cwd });
    await view.show(`${head.branch} is on ${onto} at ${rebased.sha}`);
    return { rebased: true, sha: rebased.sha, base: landed.sha, reason: "" };
  },
});
