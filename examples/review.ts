import { workflow } from "wa";
import { z } from "zod";

const Review = z.object({
  verdict: z.enum(["approved", "changes_needed"]),
  findings: z.string(),
});

function checklist(acceptance: string, findings: string): string {
  if (findings === "") return acceptance;
  return `${acceptance}\n\n# Prior review findings\n\nMake sure each one is fixed, then look wider.\n\n${findings}`;
}

export default workflow({
  description: "review a working tree against its acceptance checks",
  params: z.object({
    acceptance: z.string(),
    dir: z.string().optional(),
    findings: z.string().default(""),
  }),

  async run({ params, agent, view }) {
    const reviewer = agent({ cwd: params.dir });
    const review = (await reviewer.run("wa-review", {
      input: checklist(params.acceptance, params.findings),
      result: Review,
    }))!;
    view.fact({ verdict: review.verdict });
    return review;
  },
});
