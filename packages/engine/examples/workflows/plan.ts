import { workflow } from "penguin";
import { z } from "zod";
import { bearings, discover } from "../helpers/discover.ts";
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

export type Planned = z.infer<typeof Plan>;

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
    ticket: z
      .string()
      .describe("the ticket to plan, as an id, a url, or the text itself")
      .meta({ multiline: true }),
  }),

  async run(ctx) {
    const { params, agent, view } = ctx;
    const task = await resolveTicket(ctx, params.ticket);
    // A cheap scout finds the files first, so the planner opens code instead of hunting for it.
    const scouted = bearings(await discover(ctx, { task }));
    const session = await agent.open();
    let input = scouted === "" ? task : `${task}\n\n${scouted}`;
    for (;;) {
      const out = await narrated(view, () =>
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
