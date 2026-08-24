import { workflow } from "penguin";
import { z } from "zod";
import { resolveTicket } from "../helpers/ticket.ts";
import { narrated } from "../helpers/turns.ts";

const Plan = z.object({
  plan: z.string().describe("the finished plan, in markdown"),
  acceptance: z.string().describe("the acceptance criteria, one per line"),
});
const Out = z.object({
  result: Plan.optional().describe("fill this or blocked, and never both"),
  blocked: z
    .object({ questions: z.array(z.string()) })
    .optional()
    .describe("fill this or result, and never both"),
});

async function answered(
  questions: string[],
  ask: (question: string) => Promise<string>,
): Promise<string> {
  const answers: string[] = [];
  for (const question of questions) answers.push(`${question}\n${await ask(question)}`);
  return `# Answers\n\n${answers.join("\n\n")}`;
}

export default workflow({
  description: "plan a change with feedback and approval from the user",
  params: z.object({
    ticket: z.string().describe("the ticket to plan, as an id, a url, or the text itself"),
    context: z.string().default("").meta({ internal: true }),
  }),

  async run(ctx) {
    const { params, agent, view } = ctx;

    const ticket = await resolveTicket(ctx, params.ticket);

    const session = await agent.open();
    let input =
      params.context === "" ? ticket : `${ticket}\n\n# What triage already read\n\n${params.context}`;
    for (;;) {
      const out = await narrated(
        view,
        agent.turn(session, { skill: "plan", prompt: input }, { result: Out }),
      );
      if (out.blocked !== undefined) {
        input = await answered(out.blocked.questions, (question) => view.ask(question));
        continue;
      }
      if (out.result === undefined) {
        input = "The answer held neither result nor blocked. Fill result with the plan.";
        continue;
      }
      const plan = out.result;
      const answer = await view.ask(
        `${plan.plan}\n\nApprove the plan?`,
        z.union([z.enum(["approve"]), z.string()]),
      );
      if (answer === "approve") return plan;
      input = `# The revision the user asks for\n\n${answer}`;
    }
  },
});
