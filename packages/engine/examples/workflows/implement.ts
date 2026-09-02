import { workflow } from "penguin";
import { z } from "zod";
import { bearings, discover } from "../helpers/discover.ts";
import { REVIEWER } from "../helpers/models.ts";
import { narrated } from "../helpers/turns.ts";
import { checklist, Review } from "./review.ts";

/**
 * Every request re-reads what the requests before it grew, so an uncompacted turn pays for its
 * early reads on every call.
 */
const WINDOW = "200000";

function brief(
  task: string,
  scouted: string,
  blocking: string,
  baseline: string,
  report: string,
): string {
  const parts = [task];
  if (scouted !== "") parts.push(scouted);
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

  async run(ctx) {
    const { params, agent, gates, vcs, view } = ctx;
    // One cheap turn finds the files, so the implementer does not search on the expensive model.
    const scouted = bearings(await discover(ctx, { task: params.task }));
    const implementer = await agent.open({ autocompact: WINDOW });
    // One reviewer across the rounds: round two reads the new diff, not the whole tree again.
    const reviewer = await agent.open({ adapter: REVIEWER, autocompact: WINDOW });
    let blocking = "";
    let notes = "";
    let report = "";
    let approved = false;

    for (let round = 1; round <= params.rounds && !approved; round++) {
      await view.show(`round ${round} of ${params.rounds}`);
      await narrated(view, () =>
        agent.turn(implementer, {
          skill: "implement",
          // The rounds share the session, so the scout's list is sent once and read from there on.
          prompt: brief(
            params.task,
            round === 1 ? scouted : "",
            blocking,
            params.baseline,
            report,
          ),
        }),
      );
      // One run of the gates a round, between the two agents, so neither spends a turn on them.
      const ran = await gates.run({ since: params.base === "" ? undefined : params.base });
      // Read off the tree, not asked for: the reviewer never hunts for what the round just changed.
      const touched = (await vcs.status()).files.map((one) => one.path);
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
              bearings: touched,
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
