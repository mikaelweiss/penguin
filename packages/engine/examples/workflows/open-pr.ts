import { workflow } from "penguin";
import { z } from "zod";
import commit from "./commit.ts";

const Ack = z.union([z.enum(["ok"]), z.string()]);
const Feedback = z.union([z.enum(["address-feedback", "done"]), z.string()]);

export default workflow({
  description: "open the pull request and answer its review feedback",
  params: z.object({ dir: z.string().optional() }),

  async run(ctx) {
    const { params, agent, github, vcs, view, gate } = ctx;

    // The pull request reads the remote, so every local change goes up before it is asked for.
    async function send(): Promise<{ ok: boolean; reason: string }> {
      await commit(ctx, { dir: params.dir });
      const head = await vcs.head({ cwd: params.dir });
      if (!head.ok) return { ok: false, reason: head.reason };
      return vcs.push(head.branch, { cwd: params.dir });
    }

    const sent = await send();
    if (!sent.ok) {
      await gate(`The branch did not reach the remote: ${sent.reason}`, Ack);
      return { url: "" };
    }

    const pr = await github.pr.create({ cwd: params.dir });
    if (!pr.ok) {
      await gate(`No pull request: ${pr.reason}`, Ack);
      return { url: "" };
    }

    view.artifact({ title: "Pull request", url: pr.url });

    while ((await gate(`PR is up: ${pr.url}`, Feedback)) !== "done") {
      await agent({ cwd: params.dir }).run("penguin-address-feedback");
      const answered = await send();
      if (!answered.ok) {
        await gate(`The answers stayed local: ${answered.reason}`, Ack);
      }
    }
    return { url: pr.url };
  },
});
