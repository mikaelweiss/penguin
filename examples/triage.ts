import { workflow } from "wa";
import { z } from "zod";

const Triage = z.object({ actionable: z.boolean(), reason: z.string() });

export default workflow({
  description: "decide if a ticket is ready to work on",
  params: z.object({ ticket: z.string() }),

  async run({ params, agent, view }) {
    const triager = agent();
    const triage = (await triager.run("wa-triage", { input: params.ticket, result: Triage }))!;
    view.fact({ actionable: triage.actionable });
    return triage;
  },
});
