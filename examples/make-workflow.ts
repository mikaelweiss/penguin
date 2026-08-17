import { workflow } from "penguin";
import { z } from "zod";

const Design = z.object({ path: z.string(), summary: z.string() });
const Written = z.object({ file: z.string(), name: z.string() });
const Review = z.object({
  verdict: z.enum(["approved", "changes_needed"]),
  findings: z.string(),
});

function revision(idea: string, answer: string): string {
  return `${idea}\n\n# The revision the user asks for\n\n${answer}`;
}

function brief(design: string, dest: string, findings: string[]): string {
  const task = `Build the workflow from the design at ${design}. Write it under ${dest}.`;
  const last = findings.at(-1);
  if (last === undefined) return task;
  return `${task}\n\n# Review findings to address\n\n${last}`;
}

export default workflow({
  description: "design, write, and review a new workflow from an idea",
  params: z.object({
    idea: z.string(),
    scope: z.enum(["project", "home"]).default("home"),
    rounds: z.number().int().min(1).default(3),
  }),

  async run({ params, agent, view, gate }) {
    const dest = params.scope === "project" ? ".penguin in the current folder" : "~/.penguin";

    const author = agent();
    let design = (await author.run("penguin-design-workflow", {
      input: params.idea,
      result: Design,
    }))!;
    let answer = await gate("Approve the design? (approve / revise)");
    while (answer !== "approve") {
      design = (await author.run("penguin-design-workflow", {
        input: revision(params.idea, answer),
        result: Design,
      }))!;
      answer = await gate("Approve the design? (approve / revise)");
    }
    view.artifact({ title: "Design", path: design.path });

    let written: z.infer<typeof Written> | undefined;
    const findings: string[] = [];
    let approved = false;
    for (let round = 1; round <= params.rounds && !approved; round++) {
      approved = await view.activity(`round ${round} of ${params.rounds}`, async () => {
        view.fact({ round: `${round}/${params.rounds}` });
        written = (await author.run("penguin-write-workflow", {
          input: brief(design.path, dest, findings),
          result: Written,
        }))!;
        const reviewer = agent();
        const review = (await reviewer.run("penguin-review-workflow", {
          input: `Design: ${design.path}\nWorkflow: ${written.file}`,
          result: Review,
        }))!;
        findings.push(review.findings);
        return review.verdict === "approved";
      });
    }
    if (!approved) {
      await gate(`${params.rounds} rounds and still findings. Take a look, then answer to finish.`);
    }

    view.artifact({ title: "Workflow", path: written!.file });
    return { file: written!.file, run: `pn run ${written!.name}` };
  },
});
