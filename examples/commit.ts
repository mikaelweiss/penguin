import { workflow } from "penguin";
import { z } from "zod";

const Message = z.object({
  message: z.string().describe("the commit message, the title on the first line"),
});

export default workflow({
  description: "commit the work in the tree under a message the agent writes",
  params: z.object({ dir: z.string().optional() }),

  async run({ params, agent, vcs, view }) {
    const state = await vcs.dirty({ cwd: params.dir });
    if (!state.dirty) {
      view.fact({ commit: "nothing to commit" });
      return { committed: false, message: "", reason: state.reason };
    }

    const writer = agent({ cwd: params.dir });
    const written = (await writer.run("penguin-commit", { result: Message }))!;
    const staged = await vcs.stageAll({ cwd: params.dir });
    if (!staged.ok) {
      view.fact({ commit: "failed" });
      return { committed: false, message: written.message, reason: staged.reason };
    }

    const done = await vcs.commit(written.message, { cwd: params.dir });
    view.fact({ commit: done.ok ? "written" : "failed" });
    return { committed: done.ok, message: written.message, reason: done.reason };
  },
});
