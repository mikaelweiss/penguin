import { workflow } from "penguin";
import { z } from "zod";
import { resolveTicket } from "../helpers/ticket.ts";
import { narrated } from "../helpers/turns.ts";

/** Enough branch names to read a repository's style off, few enough to stay cheap. */
const STYLE_DEPTH = 20;

const Triage = z.object({
  actionable: z.boolean(),
  reason: z.string(),
  branch: z
    .string()
    .describe(
      "the branch the work goes on: lowercase words with dashes between them, three to five words saying what the work does, under 50 characters",
    ),
  tasks: z
    .array(z.string())
    .describe("the tasks that build the ticket, each a scope line for one vertical slice"),
});
export const Out = z.object({
  result: Triage.optional().describe("fill this or blocked, and never both"),
  blocked: z
    .object({ questions: z.array(z.string()) })
    .optional()
    .describe("fill this or result, and never both"),
});

export type Triaged = z.infer<typeof Triage>;

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
  params: z.object({
    ticket: z
      .string()
      .describe("the ticket to work, as an id, a url, or the text itself")
      .meta({ multiline: true }),
  }),

  async run(ctx) {
    const { params, agent, vcs, view } = ctx;
    const [ticket, style] = await Promise.all([
      resolveTicket(ctx, params.ticket),
      vcs.branches(STYLE_DEPTH),
    ]);
    const named =
      style.branches.length === 0 ? "" : `\n\n# Recent branch names\n\n${style.branches.join("\n")}`;
    // A ticket can attach a screenshot or a log, so the turn needs Read to open one. Nothing else
    // is on the ticket's path, and none of the person's own CLI setup means no MCP servers to wait
    // on.
    const session = await agent.open({ model: "small", tools: ["Read"], settings: [] });
    let input = `${ticket}${named}`;
    for (;;) {
      const out = await narrated(view, () =>
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
