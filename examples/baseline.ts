import { workflow } from "penguin";
import { z } from "zod";

const Gates = z.object({
  green: z.boolean().describe("true when every gate passed"),
  gates: z
    .string()
    .describe("one line per gate: the command, the verdict, and the name of each check that already fails"),
});

export default workflow({
  description: "record what the quality gates say before a change touches the tree",
  params: z.object({ dir: z.string().optional() }),

  async run({ params, agent, view }) {
    const reader = agent({ cwd: params.dir });
    const read = (await reader.run("penguin-baseline", { result: Gates }))!;
    view.fact({ baseline: read.green ? "green" : "already red" });
    return read;
  },
});
