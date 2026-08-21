import { call, workflow } from "penguin";
import { z } from "zod";
import commit from "./commit.ts";

export default workflow({
  description: "commit the tree, then push when the user says so",
  params: z.object({ dir: z.string().optional() }),

  async run(ctx) {
    const { params, vcs, view } = ctx;
    const done = await call(ctx, commit, { dir: params.dir });
    if (!done.committed) return { ...done, pushed: false };

    const head = await vcs.head({ cwd: params.dir });
    if (!head.ok || head.detached) {
      await view.show(`not pushing: ${head.detached ? "detached HEAD" : head.reason}`);
      return { ...done, pushed: false };
    }

    const answer = await view.ask(`Push ${head.branch} to origin? (yes/no)`, z.enum(["yes", "no"]));
    if (answer === "no") return { ...done, pushed: false };

    const pushed = await vcs.push(head.branch, { cwd: params.dir });
    await view.show(pushed.ok ? `pushed ${head.branch}` : `push failed: ${pushed.reason}`);
    return { ...done, pushed: pushed.ok };
  },
});
