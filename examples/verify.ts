import { workflow } from "penguin";
import { z } from "zod";

const Verify = z.object({ passing: z.boolean(), details: z.string() });

export default workflow({
  description: "run the checks of the repository and report what fails",
  params: z.object({ dir: z.string().optional() }),

  async run({ params, agent, view }) {
    const verifier = agent({ cwd: params.dir });
    const checks = (await verifier.run("penguin-verify", { result: Verify }))!;
    view.fact({ checks: checks.passing ? "passing" : "failing" });
    return checks;
  },
});
