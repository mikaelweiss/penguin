import { workflow } from "penguin";
import { z } from "zod";
import { resolveTicket } from "../helpers/ticket.ts";

const Blocked = z.object({ questions: z.array(z.string()) });
const Plan = z.object({
  plan: z.string().describe("the finished plan, in markdown"),
  acceptance: z.string().describe("the acceptance criteria, one per line"),
});

async function answered(
  questions: string[],
  gate: (question: string) => Promise<string>,
): Promise<string> {
  const answers: string[] = [];
  for (const question of questions) answers.push(`${question}\n${await gate(question)}`);
  return `# Answers\n\n${answers.join("\n\n")}`;
}

export default workflow({
  description: "plan a change with feedback and approval from the user",
  params: z.object({
    ticket: z.string(),
    dir: z.string().optional(),
    context: z.string().default(""),
  }),

  async run(ctx) {
    const { params, agent, gate } = ctx;

    const ticket = await resolveTicket(ctx, params.ticket);

    const planner = agent({ cwd: params.dir });
    let input = params.context === "" ? ticket : `${ticket}\n\n# What triage already read\n\n${params.context}`;
    for (;;) {
      const out = (await planner.run("penguin-plan", {
        input,
        result: Plan,
        blocked: Blocked,
      }))!;
      if (out.blocked !== undefined) {
        input = await answered(out.blocked.questions, gate);
        continue;
      }
      const plan = out.result;
      const answer = await gate(
        `${plan.plan}\n\nApprove the plan?`,
        z.union([z.enum(["approve"]), z.string()]),
      );
      if (answer === "approve") return plan;
      input = `# The revision the user asks for\n\n${answer}`;
    }
  },
});
