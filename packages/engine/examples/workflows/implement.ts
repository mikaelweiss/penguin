import { workflow } from "penguin";
import { z } from "zod";
import { narrated } from "../helpers/turns.ts";
import { checklist, Review } from "./review.ts";

function brief(task: string, blocking: string, baseline: string, report: string): string {
  const parts = [task];
  if (baseline !== "")
    parts.push(
      `# What the gates said before this change\n\nLeave these alone. Fix only what this change breaks.\n\n${baseline}`,
    );
  if (report !== "")
    parts.push(
      `# What the gates said after your last turn\n\npenguin ran them for you. Fix what is red here, and do not run them again.\n\n${report}`,
    );
  if (blocking !== "") parts.push(`# Review findings to fix\n\n${blocking}`);
  return parts.join("\n\n");
}

export default workflow({
  description: "implement a change and close the review findings",
  params: z.object({
    task: z.string().describe("the change to make").meta({ multiline: true }),
    rounds: z
      .number()
      .int()
      .min(1)
      .default(3)
      .describe("how many times the reviewer sends the change back before the run gives up"),
    acceptance: z.string().optional().meta({ internal: true }),
    baseline: z.string().default("").meta({ internal: true }),
    base: z.string().default("").meta({ internal: true }),
  }),

  async run({ params, agent, gates, view }) {
    const implementer = await agent.open();
    // One reviewer across the rounds: round two reads the new diff, not the whole tree again.
    const reviewer = await agent.open();
    let blocking = "";
    let notes = "";
    let report = "";
    let approved = false;

    for (let round = 1; round <= params.rounds && !approved; round++) {
      await view.show(`round ${round} of ${params.rounds}`);
      await narrated(view, () =>
        agent.turn(implementer, {
          skill: "implement",
          prompt: brief(params.task, blocking, params.baseline, report),
        }),
      );
      // One run of the gates a round, between the two agents, so neither spends a turn on them.
      const ran = await gates.run({ since: params.base === "" ? undefined : params.base });
      await view.show(ran.green ? "gates: green" : "gates: red");
      report = ran.report;
      const reviewed = await narrated(view, () =>
        agent.turn(
          reviewer,
          {
            skill: "review",
            prompt: checklist({
              acceptance: params.acceptance ?? params.task,
              blocking,
              baseline: params.baseline,
              gates: report,
              base: params.base,
            }),
          },
          { result: Review },
        ),
      );
      await view.show(`verdict: ${reviewed.verdict}`);
      blocking = reviewed.blocking;
      notes = reviewed.notes;
      approved = reviewed.verdict === "approved";
    }
    return { approved, blocking, notes };
  },
});
