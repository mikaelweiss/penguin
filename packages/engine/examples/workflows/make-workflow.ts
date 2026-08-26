import { workflow } from "penguin";
import { z } from "zod";
import { narrated } from "../helpers/turns.ts";

const Approval = z.union([z.enum(["approve", "revise"]), z.string()]);
const Design = z.object({ design: z.string().describe("the whole design, in markdown") });
const Written = z.object({ file: z.string(), name: z.string() });
const Review = z.object({
  verdict: z.enum(["approved", "changes_needed"]),
  findings: z.string(),
});

function revision(idea: string, answer: string): string {
  return `${idea}\n\n# The revision the user asks for\n\n${answer}`;
}

function brief(design: string, dest: string, findings: string[]): string {
  const task = `Build the workflow from the design below. Write it under ${dest}.\n\n# Design\n\n${design}`;
  const last = findings.at(-1);
  if (last === undefined) return task;
  return `${task}\n\n# Review findings to address\n\n${last}`;
}

export default workflow({
  description: "design, write, and review a new workflow from an idea",
  params: z.object({
    idea: z.string().describe("what the new workflow should do").meta({ multiline: true }),
    scope: z
      .enum(["project", "home"])
      .default("home")
      .describe("which catalog it is written into"),
    rounds: z
      .number()
      .int()
      .min(1)
      .default(3)
      .describe("how many times the reviewer sends the workflow back before the run gives up"),
  }),

  async run({ params, agent, view }) {
    const dest = params.scope === "project" ? ".penguin in the current folder" : "~/.penguin";

    const author = await agent.open();
    let design = await narrated(
      view,
      agent.turn(author, { skill: "design-workflow", prompt: params.idea }, { result: Design }),
    );
    let answer = await view.ask(`${design.design}\n\nApprove the design?`, Approval);
    while (answer !== "approve") {
      design = await narrated(
        view,
        agent.turn(
          author,
          { skill: "design-workflow", prompt: revision(params.idea, answer) },
          { result: Design },
        ),
      );
      answer = await view.ask(`${design.design}\n\nApprove the design?`, Approval);
    }

    let written: z.infer<typeof Written> | undefined;
    const findings: string[] = [];
    let approved = false;
    for (let round = 1; round <= params.rounds && !approved; round++) {
      await view.show(`round ${round} of ${params.rounds}`);
      written = await narrated(
        view,
        agent.turn(
          author,
          { skill: "write-workflow", prompt: brief(design.design, dest, findings) },
          { result: Written },
        ),
      );
      const reviewer = await agent.open();
      const review = await narrated(
        view,
        agent.turn(
          reviewer,
          {
            skill: "review-workflow",
            prompt: `# Design\n\n${design.design}\n\n# Workflow\n\n${written.file}`,
          },
          { result: Review },
        ),
      );
      findings.push(review.findings);
      approved = review.verdict === "approved";
    }
    if (!approved) {
      await view.ask(
        `${params.rounds} rounds and still findings. Take a look.`,
        z.enum(["ok"]),
      );
    }

    await view.show(`workflow: ${written!.file}`);
    return { file: written!.file, name: written!.name };
  },
});
