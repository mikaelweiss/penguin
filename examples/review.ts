import { workflow } from "penguin";
import { z } from "zod";

export const Review = z.object({
  verdict: z.enum(["approved", "changes_needed"]),
  blocking: z
    .string()
    .describe("the defects this change must fix before it lands, one per line, empty when none"),
  notes: z.string().describe("what else the reader should know, one per line"),
});

export type Brief = {
  acceptance: string;
  blocking?: string;
  baseline?: string;
  base?: string;
};

/** Everything the reviewer needs that it cannot read off the tree itself. */
export function checklist(brief: Brief): string {
  const parts = [brief.acceptance];
  if (brief.base !== undefined && brief.base !== "")
    parts.push(
      `# The base\n\nThe change is \`git diff ${brief.base}..HEAD\`. Read that, never a moving branch.`,
    );
  if (brief.baseline !== undefined && brief.baseline !== "")
    parts.push(
      `# What the gates said before this change\n\nA gate that already failed here is not this change's defect. Do not re-derive it, and do not block on it.\n\n${brief.baseline}`,
    );
  if (brief.blocking !== undefined && brief.blocking !== "")
    parts.push(
      `# Blocking findings from the last round\n\nCheck each one is fixed, then look wider.\n\n${brief.blocking}`,
    );
  return parts.join("\n\n");
}

export default workflow({
  description: "review a working tree against its acceptance checks",
  params: z.object({
    acceptance: z.string(),
    dir: z.string().optional(),
    blocking: z.string().default(""),
    baseline: z.string().default(""),
    base: z.string().default(""),
  }),

  async run({ params, agent, view }) {
    const reviewer = agent({ cwd: params.dir });
    const review = (await reviewer.run("penguin-review", {
      input: checklist(params),
      result: Review,
    }))!;
    view.fact({ verdict: review.verdict });
    return review;
  },
});
