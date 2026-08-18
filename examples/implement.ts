import { workflow } from "penguin";
import { z } from "zod";
import { checklist, Review } from "./review.ts";

function brief(task: string, blocking: string, baseline: string): string {
  const parts = [task];
  if (baseline !== "")
    parts.push(
      `# What the gates said before this change\n\nLeave these alone. Fix only what this change breaks.\n\n${baseline}`,
    );
  if (blocking !== "") parts.push(`# Review findings to fix\n\n${blocking}`);
  return parts.join("\n\n");
}

export default workflow({
  description: "implement a change and close the review findings",
  params: z.object({
    task: z.string(),
    acceptance: z.string().optional(),
    dir: z.string().optional(),
    baseline: z.string().default(""),
    base: z.string().default(""),
    rounds: z.number().int().min(1).default(3),
  }),

  async run({ params, agent, view }) {
    view.watch({ elapsed: true, diff: params.dir ?? "." });

    const implementer = agent({ cwd: params.dir });
    // One reviewer across the rounds: round two reads the new diff, not the whole tree again.
    const reviewer = agent({ cwd: params.dir });
    let blocking = "";
    let notes = "";
    let approved = false;

    for (let round = 1; round <= params.rounds && !approved; round++) {
      approved = await view.activity(`round ${round} of ${params.rounds}`, async () => {
        view.fact({ round: `${round}/${params.rounds}` });
        await implementer.run("penguin-implement", {
          input: brief(params.task, blocking, params.baseline),
        });
        const reviewed = (await reviewer.run("penguin-review", {
          input: checklist({
            acceptance: params.acceptance ?? params.task,
            blocking,
            baseline: params.baseline,
            base: params.base,
          }),
          result: Review,
        }))!;
        view.fact({ verdict: reviewed.verdict });
        blocking = reviewed.blocking;
        notes = reviewed.notes;
        return reviewed.verdict === "approved";
      });
    }
    return { approved, blocking, notes };
  },
});
