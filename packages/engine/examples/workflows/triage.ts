import { workflow } from "penguin";
import { z } from "zod";
import { resolveTicket } from "../helpers/ticket.ts";
import { narrated } from "../helpers/turns.ts";

const Triage = z.object({
  actionable: z.boolean(),
  reason: z.string(),
  tasks: z.array(z.string()).describe("the tasks that build the ticket, each one a vertical slice"),
  context: z
    .string()
    .describe("the files read and what each one holds, so the planner reads them once, not twice"),
});
const Out = z.object({
  result: Triage.optional().describe("fill this or blocked, and never both"),
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
  description: "decide if a ticket is ready to work on, and split it into tasks",
  params: z.object({ ticket: z.string().describe("the ticket to work, as an id, a url, or the text itself") }),

  async run(ctx) {
    const { params, agent, view } = ctx;
    const ticket = await resolveTicket(ctx, params.ticket);
    const session = await agent.open();
    let input = ticket;
    for (;;) {
      const out = await narrated(
        view,
        agent.turn(session, { skill: "triage", prompt: input }, { result: Out }),
      );
      if (out.blocked !== undefined) {
        input = await answered(out.blocked.questions, (question) => view.ask(question));
        continue;
      }
      if (out.result === undefined) {
        input = "The answer held neither result nor blocked. Fill result with the triage.";
        continue;
      }
      const triage = out.result;
      if (!triage.actionable) {
        await view.show(`not actionable: ${triage.reason}`);
        return triage;
      }
      const tasks = triage.tasks.length === 0 ? [ticket] : triage.tasks;
      if (tasks.length === 1) return { ...triage, tasks };
      const listed = tasks.map((task, index) => `${index + 1}. ${task}`).join("\n");
      const answer = await view.ask(
        `The ticket splits into ${tasks.length} tasks:\n\n${listed}\n\nApprove the split?`,
        z.union([z.enum(["approve"]), z.string()]),
      );
      if (answer === "approve") return { ...triage, tasks };
      input = `# The revision the user asks for\n\n${answer}`;
    }
  },
});
