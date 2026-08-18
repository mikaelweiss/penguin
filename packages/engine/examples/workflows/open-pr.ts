import { workflow } from "penguin";
import { z } from "zod";

const Ack = z.union([z.enum(["ok"]), z.string()]);
const Feedback = z.union([z.enum(["address-feedback", "done"]), z.string()]);

export default workflow({
  description: "open the pull request and answer its review feedback",
  params: z.object({ dir: z.string().optional() }),

  async run({ params, agent, github, view, gate }) {
    const pr = await github.pr.create({ cwd: params.dir });
    if (!pr.ok) {
      await gate(`No pull request: ${pr.reason}`, Ack);
      return { url: "" };
    }

    view.artifact({ title: "Pull request", url: pr.url });

    while ((await gate(`PR is up: ${pr.url}`, Feedback)) !== "done") {
      await agent({ cwd: params.dir }).run("penguin-address-feedback");
    }
    return { url: pr.url };
  },
});
