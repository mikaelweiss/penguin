import { workflow } from "wa";
import { z } from "zod";

const Plan = z.object({ spec: z.string(), acceptance: z.string() });

function revision(ticket: string, answer: string): string {
  return `${ticket}\n\n# The revision the user asks for\n\n${answer}`;
}

export default workflow({
  description: "plan a change, then hold it at an approval gate",
  params: z.object({ ticket: z.string(), dir: z.string().optional() }),

  async run({ params, agent, view, gate }) {
    const planner = agent({ cwd: params.dir });
    let plan = (await planner.run("wa-plan", { input: params.ticket, result: Plan }))!;
    let answer = await gate("Approve the plan? (approve / revise)");
    while (answer !== "approve") {
      plan = (await planner.run("wa-plan", {
        input: revision(params.ticket, answer),
        result: Plan,
      }))!;
      answer = await gate("Approve the plan? (approve / revise)");
    }
    view.artifact({ title: "Plan", path: plan.spec });
    return plan;
  },
});
