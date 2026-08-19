import { workflow } from "penguin";
import { z } from "zod";

const Commit = z.object({
  files: z
    .array(z.string())
    .describe("the paths to commit, as git status prints them, empty when nothing belongs in one"),
  message: z.string().describe("the commit message, the title on the first line"),
});

export default workflow({
  description: "commit the work in the tree: the agent picks the files and writes the message",
  params: z.object({ dir: z.string().optional() }),

  async run({ params, agent, vcs, view }) {
    const state = await vcs.dirty({ cwd: params.dir });
    if (!state.dirty) {
      view.fact({ commit: "nothing to commit" });
      return { committed: false, message: "", reason: state.reason };
    }

    const writer = agent({ cwd: params.dir });
    const written = (await writer.run("penguin-commit", { result: Commit }))!;
    if (written.files.length === 0) {
      view.fact({ commit: "nothing worth committing" });
      return { committed: false, message: written.message, reason: "the agent picked no files" };
    }

    const staged = await vcs.stage(written.files, { cwd: params.dir });
    if (!staged.ok) {
      view.fact({ commit: "failed" });
      return { committed: false, message: written.message, reason: staged.reason };
    }

    const done = await vcs.commit(written.message, { cwd: params.dir });
    view.fact({ commit: done.ok ? "written" : "failed" });
    return { committed: done.ok, message: written.message, reason: done.reason };
  },
});
