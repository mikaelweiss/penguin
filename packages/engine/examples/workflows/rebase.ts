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
    from: z
      .string()
      .default("")
      .describe(
        "the commit the branch was cut from, empty when that was the base. Set it when a parent was squashed under the branch, so the parent's commits are not replayed",
      ),
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
    const dropped = { rebased: false, sha: "", base: "", reason: "the user dropped the rebase" };
    let turns = 0;
    let fixer = "";

    /**
     * What the resolver reads instead of fetching it: what the rebase has landed,
     * what it is replaying now, and every conflicted file as the tree holds it. A
     * file too large for the prompt is cut, and the resolver reads that one itself.
     */
    const tree = async (): Promise<string> => {
      const [landed, patch, open] = await Promise.all([
        vcs.log(1, { cwd }),
        vcs.rebase.patch({ cwd }),
        vcs.rebase.conflicts({ cwd }),
      ]);
      const held = await Promise.all(
        open.files.map(async (file) => {
          const found = await vcs.read(file, { cwd });
          if (!found.there) return `## ${file}\n\nNothing stands at this path.`;
          const text = found.truncated
            ? `${found.text}\n\n… cut here. Read ${file} for the rest.`
            : found.text;
          return `## ${file}\n\n${text}`;
        }),
      );
      return [
        `# HEAD\n\n${landed.text}`,
        `# Replaying\n\n${patch.truncated ? `${patch.text}\n\n… cut here.` : patch.text}`,
        `# Conflicted files\n\n${held.length === 0 ? "None left." : held.join("\n\n")}`,
      ].join("\n\n");
    };

    // One session across the passes, so the resolver keeps what it already learned about the tree.
    const resolving = async (said: string): Promise<z.infer<typeof Resolved>> => {
      const prompt = `${await tree()}\n\n${said}`;
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
          `The conflicts are still open: ${said}\n\nResolve them and stage the files. continue goes on with what is staged, abort drops the rebase. Anything else goes to the resolver.`,
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

    // A rebase a run died inside is dropped, which puts the branch back where that run found it.
    if (await vcs.rebase.pending({ cwd })) {
      await view.show(`${folder} held an unfinished rebase, so it is dropped and replayed here.`);
      await vcs.rebase.abort({ cwd });
    }

    const base = await resolveBase(ctx, params.base);
    if (base === "") return { ...dropped, reason: "no base branch" };
    const onto = params.local ? base : `origin/${base}`;
    const from = params.from === "" ? undefined : params.from;

    let clean = false;
    while (!clean) {
      for (let pass = 1; pass <= params.passes && !clean; pass++) {
        await view.show(`pass ${pass} of ${params.passes}`);
        if (!params.local) await vcs.fetch(base, { cwd });

        let state = await vcs.rebase.onto(onto, { cwd, from });
        const conflicted = state.conflicted;
        while (state.conflicted) {
          const stopped = `The rebase onto ${onto} stopped on these files:\n\n${listed(state.files)}`;
          if (!(await mended(stopped))) {
            await vcs.rebase.abort({ cwd });
            return dropped;
          }
          state = await vcs.rebase.continue({ cwd });
        }
        // Conflicts take time, and the base can move while they are resolved, so a pass that hit
        // any of them runs again to see what arrived.
        clean = !conflicted;
      }

      if (clean) break;
      const answer = await view.ask(
        `${params.passes} rebase passes, and ${base} keeps moving.\n\ncontinue keeps going, abort drops the rebase.`,
        Answer,
      );
      if (answer === "abort") return dropped;
    }

    // The caller reviews the branch against what it now sits on, so the ref it landed under is pinned here.
    const landed = await vcs.sha(onto, { cwd });
    const rebased = await vcs.head({ cwd });
    await view.show(`${rebased.branch} is on ${onto} at ${rebased.sha}`);
    return { rebased: true, sha: rebased.sha, base: landed.sha, reason: "" };
  },
});
