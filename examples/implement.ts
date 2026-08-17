import { workflow } from "wa";
import { z } from "zod";
import review from "./review.ts";

function brief(task: string, findings: string[]): string {
  const last = findings.at(-1);
  if (last === undefined) return task;
  return `${task}\n\n# Review findings to address\n\n${last}`;
}

export default workflow({
  description: "implement a change and close the review findings",
  params: z.object({
    task: z.string(),
    acceptance: z.string().optional(),
    dir: z.string().optional(),
    rounds: z.number().int().min(1).default(3),
  }),

  async run(ctx) {
    const { params, agent, view } = ctx;
    view.watch({ elapsed: true, diff: params.dir ?? "." });

    const implementer = agent({ cwd: params.dir });
    const findings: string[] = [];
    let approved = false;

    for (let round = 1; round <= params.rounds && !approved; round++) {
      approved = await view.activity(`round ${round} of ${params.rounds}`, async () => {
        view.fact({ round: `${round}/${params.rounds}` });
        await implementer.run("wa-implement", { input: brief(params.task, findings) });
        const reviewed = await review(ctx, {
          acceptance: params.acceptance ?? params.task,
          dir: params.dir,
          findings: findings.join("\n\n"),
        });
        findings.push(reviewed.findings);
        return reviewed.verdict === "approved";
      });
    }
    return { approved, findings };
  },
});
