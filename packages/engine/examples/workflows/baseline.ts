import { workflow } from "penguin";
import { z } from "zod";
import { narrated } from "../helpers/turns.ts";

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
    const session = await agent.open({ cwd: params.dir });
    const read = await narrated(view, agent.turn(session, { skill: "baseline" }, { result: Gates }));
    await view.show(read.green ? "baseline: green" : "baseline: already red");
    return read;
  },
});
