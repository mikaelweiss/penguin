import { messageOf, workflow, type Ctx } from "penguin";
import { z } from "zod";
import { resolveTicket } from "../helpers/ticket.ts";
import { narrated } from "../helpers/turns.ts";

/** Enough branch names to read a repository's style off, few enough to stay cheap. */
const STYLE_DEPTH = 20;

/** What the app heads any message carrying files with, a clarification included. */
const ATTACHED = "# Attached files\n";

/** A ticket Jev judged whole holds everything the split needs, so nothing opens and no MCP server is waited on. */
const READS = { model: "small", tools: ["Read"], settings: [] };

/**
 * A ticket Jev could not read the whole of. The turn keeps the person's own setup, whose tools are
 * already signed in to the systems the ticket names, and takes what opens a pointer.
 */
const OPENS = { model: "small", tools: ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Bash"] };

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

type Screened = { actionable: boolean; reason: string };

async function answered(
  questions: string[],
  ask: (question: string) => Promise<string>,
): Promise<string> {
  const answers: string[] = [];
  for (const question of questions) answers.push(`${question}\n${await ask(question)}`);
  return `# Answers\n\n${answers.join("\n\n")}`;
}

/**
 * Jev's verdict, or nothing when Jev did not have the whole ticket to judge. It reads text alone,
 * so a ticket carrying a file, or naming something its text does not identify, is one it never
 * ruled on: that ticket is the turn's to open and triage for itself.
 */
async function screened(ctx: Ctx<unknown>, ticket: string): Promise<Screened | undefined> {
  if (ticket.includes(ATTACHED)) return undefined;
  try {
    const judged = await ctx.jev.triage.ticket({ ticket });
    return judged.missing === "reference" ? undefined : judged;
  } catch (error) {
    await ctx.view.show(`The Jev triage did not run, so the turn triages the ticket itself: ${messageOf(error)}`);
    return undefined;
  }
}

export default workflow({
  description: "decide if a ticket is ready to work on, and split it into tasks",
  params: z.object({
    ticket: z
      .string()
      .describe("the ticket to work, as an id, a url, or the text itself")
      .meta({ multiline: true }),
  }),

  async run(ctx): Promise<Triaged> {
    const { params, agent, vcs, view } = ctx;
    const [ticket, style] = await Promise.all([
      resolveTicket(ctx, params.ticket),
      vcs.branches(STYLE_DEPTH),
    ]);

    // Jev triages in a fraction of a second, and what it rules on stands: a no-go reaches the
    // person without a turn, and what it finds missing joins the ticket for the next judgment.
    let text = ticket;
    let judged = await screened(ctx, text);
    while (judged !== undefined && !judged.actionable) {
      const answer = await view.ask(
        `The ticket is not ready to build: ${judged.reason}\n\nAdd what is missing, or stop.`,
        z.union([z.enum(["stop"]), z.string()]),
      );
      if (answer === "stop") {
        await view.show(`not actionable: ${judged.reason}`);
        return { actionable: false, reason: judged.reason, branch: "", tasks: [] };
      }
      text = `${text}\n\n# Clarifications\n\n${answer}`;
      judged = await screened(ctx, text);
    }

    const named =
      style.branches.length === 0 ? "" : `\n\n# Recent branch names\n\n${style.branches.join("\n")}`;
    // A ticket Jev never ruled on is triaged here instead, the way it was before Jev: the turn
    // opens the link, the screenshot, or the screen the ticket names, and judges what it finds.
    const session = await agent.open(judged === undefined ? OPENS : READS);
    let input = `${text}${named}`;
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
      const tasks = triage.tasks.length === 0 ? [text] : triage.tasks;
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
