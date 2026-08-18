import { workflow } from "penguin";
import { z } from "zod";

const Blocked = z.object({ questions: z.array(z.string()) });
const Triage = z.object({
  actionable: z.boolean(),
  reason: z.string(),
  tasks: z.array(z.string()).describe("the tasks that build the ticket, each one a vertical slice"),
  context: z
    .string()
    .describe("the files read and what each one holds, so the planner reads them once, not twice"),
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
  description: "decide if a ticket is ready to work on, and split it into tasks",
  params: z.object({ ticket: z.string() }),

  async run({ params, agent, view, gate }) {
    const triager = agent();
    let input = params.ticket;
    for (;;) {
      const out = (await triager.run("penguin-triage", {
        input,
        result: Triage,
        blocked: Blocked,
      }))!;
      if (out.blocked !== undefined) {
        input = await answered(out.blocked.questions, gate);
        continue;
      }
      const triage = out.result;
      if (!triage.actionable) {
        view.fact({ actionable: false });
        return triage;
      }
      const tasks = triage.tasks.length === 0 ? [params.ticket] : triage.tasks;
      view.fact({ actionable: true, tasks: tasks.length });
      if (tasks.length === 1) return { ...triage, tasks };
      const listed = tasks.map((task, index) => `${index + 1}. ${task}`).join("\n");
      const answer = await gate(
        `The ticket splits into ${tasks.length} tasks:\n\n${listed}\n\nType approve, or type what to change.`,
      );
      if (answer === "approve") return { ...triage, tasks };
      input = `# The revision the user asks for\n\n${answer}`;
    }
  },
});
