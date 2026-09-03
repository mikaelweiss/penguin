import { workflow } from "penguin";
import { z } from "zod";
import { bearings, discover } from "../helpers/discover.ts";
import { resolveTicket } from "../helpers/ticket.ts";
import { narrated } from "../helpers/turns.ts";

const Plan = z.object({
  plan: z.string().describe("the finished plan, in markdown"),
  acceptance: z.string().describe("the acceptance criteria, one per line"),
});
const Option = z.object({
  name: z.string().describe("two or three words"),
  tradeoff: z.string().describe("what it costs and what it buys, one or two sentences"),
});
export const Out = z.object({
  result: Plan.optional().describe("the plan. Fill exactly one of result, blocked, decide, resplit"),
  blocked: z
    .object({ questions: z.array(z.string()) })
    .optional()
    .describe("facts only the requester has"),
  decide: z
    .object({
      question: z.string(),
      options: z.array(Option).min(2).max(3),
      recommended: z.string().describe("the name of the option you would take"),
    })
    .optional()
    .describe("a choice the ticket and the code do not settle, and that matters"),
  resplit: z
    .object({
      reason: z.string().describe("what the code showed, one or two sentences"),
      tasks: z.array(z.string()).min(1).describe("the tasks that remain, yours first"),
    })
    .optional()
    .describe("the code shows the remaining split is wrong"),
});

export type Planned = z.infer<typeof Plan> & { tasks: string[] };

const Approved = z.union([z.enum(["approve"]), z.string()]);

function numbered(tasks: string[]): string {
  return tasks.map((task, index) => `${index + 1}. ${task}`).join("\n");
}

/** Where this task sits in the split, so the planner sees its edges and who owns what lies past them. */
function fence(tasks: string[], done: number): string {
  if (tasks.length < 2) return "";
  const built = done === 0 ? "" : ` Tasks 1 to ${done} are in the worktree already.`;
  return `# The split\n\nThis ticket builds in ${tasks.length} tasks.${built} Task ${done + 1} is yours.\n\n${numbered(tasks)}`;
}

function brief(ticket: string, split: string, scouted: string): string {
  return [ticket, split, scouted].filter((part) => part !== "").join("\n\n");
}

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
    tasks: z
      .array(z.string())
      .default([])
      .describe("the split the ticket builds in, empty when the ticket is one task")
      .meta({ internal: true }),
    done: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("how many of the tasks are built already")
      .meta({ internal: true }),
  }),

  async run(ctx) {
    const { params, agent, view } = ctx;
    const ticket = await resolveTicket(ctx, params.ticket);
    let tasks = params.tasks;
    const task = brief(ticket, fence(tasks, params.done), "");
    // A cheap scout finds the files first, so the planner opens code instead of hunting for it.
    const scouted = bearings(await discover(ctx, { task }));
    const session = await agent.open();
    let input = brief(ticket, fence(tasks, params.done), scouted);
    for (;;) {
      const out = await narrated(view, () =>
        agent.turn(session, { skill: "plan", prompt: input }, { result: Out }),
      );
      if (out.blocked !== undefined) {
        input = await answered(out.blocked.questions, (question) => view.ask(question));
        continue;
      }
      if (out.decide !== undefined) {
        const { question, options, recommended } = out.decide;
        const listed = options.map((one) => `${one.name}: ${one.tradeoff}`).join("\n");
        const names = options.map((one) => one.name) as [string, ...string[]];
        const answer = await view.ask(
          `${question}\n\n${listed}\n\nThe planner recommends ${recommended}. Pick one, or say what to do instead.`,
          z.union([z.enum(names), z.string()]),
        );
        input = `# The decision\n\n${question}\n${answer}`;
        continue;
      }
      if (out.resplit !== undefined) {
        const proposed = [...tasks.slice(0, params.done), ...out.resplit.tasks];
        const answer = await view.ask(
          `The code changes the split. ${out.resplit.reason}\n\nThe work that remains:\n\n${numbered(out.resplit.tasks)}\n\nApprove the split?`,
          Approved,
        );
        if (answer === "approve") {
          tasks = proposed;
          input = `# The split is approved\n\n${fence(tasks, params.done)}\n\nPlan task ${params.done + 1}.`;
        } else {
          input = `# The revision the user asks for\n\n${answer}`;
        }
        continue;
      }
      if (out.result === undefined) {
        input = "The answer held none of result, blocked, decide, or resplit. Fill result with the plan.";
        continue;
      }
      const plan = out.result;
      const answer = await view.ask(`${plan.plan}\n\nApprove the plan?`, Approved);
      if (answer === "approve") return { ...plan, tasks };
      input = `# The revision the user asks for\n\n${answer}`;
    }
  },
});
