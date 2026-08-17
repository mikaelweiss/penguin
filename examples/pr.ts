import { workflow } from "wa";
import { z } from "zod";

export default workflow({
  description: "open the pull request and answer its review feedback",
  params: z.object({ dir: z.string().optional() }),

  async run({ params, agent, github, view, gate }) {
    const pr = await github.pr.create({ cwd: params.dir });
    if (!pr.ok) {
      await gate(`No pull request: ${pr.reason}`);
      return { url: "" };
    }

    view.artifact({ title: "Pull request", url: pr.url });
    while ((await gate(`PR is up: ${pr.url} (address-feedback / done)`)) !== "done") {
      const fixer = agent({ cwd: params.dir });
      await fixer.run("wa-address-feedback");
    }
    return { url: pr.url };
  },
});
