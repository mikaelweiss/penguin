import { workflow } from "penguin";
import { z } from "zod";
import { narrated } from "../helpers/turns.ts";

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
  gates?: string;
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
  if (brief.gates !== undefined && brief.gates !== "")
    parts.push(
      `# What the gates say now\n\npenguin ran them on this tree after the change. Read them here, and do not run one yourself.\n\n${brief.gates}`,
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
    acceptance: z
      .string()
      .describe("what the change has to satisfy, one check per line")
      .meta({ multiline: true }),
    blocking: z.string().default("").meta({ internal: true }),
    baseline: z.string().default("").meta({ internal: true }),
    base: z.string().default("").meta({ internal: true }),
  }),

  async run({ params, agent, gates, view }) {
    // The gates run here, once, so the reviewer reads a verdict instead of producing one.
    const ran = await gates.run({ since: params.base === "" ? undefined : params.base });
    await view.show(ran.green ? "gates: green" : "gates: red");
    const session = await agent.open();
    const review = await narrated(view, () =>
      agent.turn(
        session,
        { skill: "review", prompt: checklist({ ...params, gates: ran.report }) },
        { result: Review },
      ),
    );
    await view.show(`verdict: ${review.verdict}`);
    return review;
  },
});
