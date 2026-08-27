import { messageOf, workflow } from "penguin";
import { z } from "zod";
import { resolveBase } from "../helpers/base.ts";
import { narrated } from "../helpers/turns.ts";

const Answer = z.enum(["continue", "abort"]);
const Fixing = z.union([Answer, z.string()]);
const Resolved = z.object({
  resolved: z.boolean(),
  notes: z.string().describe("what the conflict was, and what is left when it is not resolved"),
});

type Done = { ok: boolean; reason: string };

function listed(files: string[]): string {
  return files.map((file) => `- ${file}`).join("\n");
}

export default workflow({
  description: "rebase the worktree's branch onto its base until a pass runs clean",
  params: z.object({
    base: z
      .string()
      .default("main")
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
    const dropped = "the user dropped the rebase";
    let turns = 0;
    let clean = false;
    let fixer = "";

    // One session across the passes, so the resolver keeps what it already learned about the tree.
    const resolving = async (prompt: string): Promise<z.infer<typeof Resolved>> => {
      try {
        if (fixer === "") fixer = await agent.open({ cwd });
        return await narrated(view, () =>
          agent.turn(fixer, { skill: "resolve-conflicts", prompt }, { result: Resolved }),
        );
      } catch (error) {
        // An agent that will not run is one more thing the person can settle, never the run's end.
        return { resolved: false, notes: `The agent did not answer: ${messageOf(error)}` };
      }
    };

    /**
     * The gate open conflicts stop at. The resolver just stopped, so what the person types is its
     * next instruction, and no bound applies to a turn a person asked for by hand.
     */
    const directed = async (notes: string): Promise<boolean> => {
      let said = notes;
      for (;;) {
        const answer = await view.ask(
          `The conflicts are still open: ${said}\n\nResolve them and stage the files, then type continue. Type abort to drop the rebase. Anything else goes to the resolver.`,
          Fixing,
        );
        if (answer === "abort") return false;
        if (answer === "continue") return true;
        const fixed = await resolving(`The user says:\n\n${answer}\n\nAnswer it and act on it.`);
        if (fixed.resolved) return true;
        said = fixed.notes;
      }
    };

    /** The resolver's turns are bounded. A person's are not, so a spent bound hands them the tree. */
    const mended = async (said: string): Promise<boolean> => {
      if (turns === params.resolutions) return directed(said);
      turns += 1;
      const fixed = await resolving(said);
      return fixed.resolved ? true : directed(fixed.notes);
    };

    /** What only a person can settle. The rebase waits here rather than ending on it. */
    const settled = async (said: string): Promise<boolean> => {
      const answer = await view.ask(`${said}\n\nSettle it and type continue, or abort to drop the rebase.`, Answer);
      return answer === "continue";
    };

    /** A step the rebase cannot go on without. It runs again until it passes or the person drops it. */
    const insisted = async (what: string, step: () => Promise<Done>): Promise<boolean> => {
      for (;;) {
        const done = await step();
        if (done.ok) return true;
        if (!(await settled(`${what}\n\n${done.reason}`))) return false;
      }
    };

    /** A rebase a run died inside. Dropping it puts the branch back where that run found it. */
    const cleared = async (): Promise<void> => {
      if (!(await vcs.rebase.pending({ cwd }))) return;
      await view.show(`${folder} held an unfinished rebase, so it is dropped and replayed here.`);
      await vcs.rebase.abort({ cwd });
    };

    /** What stops the rebase before it starts, empty when nothing does. */
    const amiss = async (): Promise<string> => {
      const head = await vcs.head({ cwd });
      if (!head.ok) return `${folder} did not read: ${head.reason}`;
      if (head.detached) return `${folder} is detached, so there is no branch to rebase.`;
      const tree = await vcs.dirty({ cwd });
      if (tree.dirty) return `${folder} has uncommitted changes. Commit or drop them first.`;
      return "";
    };

    await cleared();
    for (let wrong = await amiss(); wrong !== ""; wrong = await amiss()) {
      if (!(await settled(wrong))) return nowhere(dropped);
    }

    const base = await resolveBase(ctx, params.base);
    if (base === "") return nowhere("no base branch");
    const onto = params.local ? base : `origin/${base}`;

    while (!clean) {
      for (let pass = 1; pass <= params.passes && !clean; pass++) {
        await view.show(`pass ${pass} of ${params.passes}`);
        if (!(await insisted(`The fetch of ${base} failed.`, () => vcs.fetch(base, { cwd })))) {
          return nowhere(dropped);
        }
        await cleared();

        let state = await vcs.rebase.onto(onto, { cwd });
        const conflicted = state.conflicted;
        while (state.conflicted) {
          const stopped = `The rebase onto ${onto} stopped on these files:\n\n${listed(state.files)}`;
          if (!(await mended(stopped))) {
            await vcs.rebase.abort({ cwd });
            return nowhere(dropped);
          }
          state = await vcs.rebase.continue({ cwd });
        }

        if (!state.ok) {
          if (!(await settled(`The rebase onto ${onto} failed:\n\n${state.reason}`))) {
            return nowhere(dropped);
          }
          continue;
        }
        // Conflicts take time, and the base can move while they are resolved, so a pass that hit
        // any of them runs again to see what arrived.
        clean = !conflicted;
      }

      if (clean) break;
      if (!(await settled(`${params.passes} rebase passes, and ${base} keeps moving.`))) {
        return nowhere(dropped);
      }
    }

    // The caller reviews the branch against what it now sits on, so the ref it landed under is pinned here.
    const landed = await vcs.sha(onto, { cwd });
    const rebased = await vcs.head({ cwd });
    await view.show(`${rebased.branch} is on ${onto} at ${rebased.sha}`);
    return { rebased: true, sha: rebased.sha, base: landed.sha, reason: "" };
  },
});
