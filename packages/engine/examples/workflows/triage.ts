import { messageOf, workflow } from "penguin";
import { z } from "zod";
import { resolveTicket } from "../helpers/ticket.ts";
import { narrated } from "../helpers/turns.ts";

/** Enough branch names to read a repository's style off, few enough to stay cheap. */
const STYLE_DEPTH = 20;

/** What the app writes over a ticket that carries files. Jev reads text alone, so such a ticket skips it. */
const ATTACHED = "# Attached files\n";

export const Out = z.object({
  branch: z
    .string()
    .describe(
      "the branch the work goes on: lowercase words with dashes between them, three to five words saying what the work does, under 50 characters",
    ),
  tasks: z
    .array(z.string())
    .describe("the tasks that build the ticket, each a scope line for one vertical slice"),
});

export type Triaged = { actionable: boolean; reason: string; branch: string; tasks: string[] };

export default workflow({
  description: "decide if a ticket is ready to work on, and split it into tasks",
  params: z.object({
    ticket: z
      .string()
      .describe("the ticket to work, as an id, a url, or the text itself")
      .meta({ multiline: true }),
  }),

  async run(ctx): Promise<Triaged> {
    const { params, agent, jev, vcs, view } = ctx;
    const [ticket, style] = await Promise.all([
      resolveTicket(ctx, params.ticket),
      vcs.branches(STYLE_DEPTH),
    ]);

    // Jev gives the go or no-go. What it finds missing goes to the person, whose words join
    // the ticket for the next judgment. A Jev that will not answer sends the ticket on as it is:
    // the planner asks what a vague ticket leaves open.
    let text = ticket;
    let reason = "the ticket attaches files, which the split reads";
    while (!ticket.startsWith(ATTACHED)) {
      let judged: { actionable: boolean; reason: string };
      try {
        judged = await jev.triage.ticket({ ticket: text });
      } catch (error) {
        await view.show(`The Jev triage did not run, so the ticket goes to the split as it is: ${messageOf(error)}`);
        judged = { actionable: true, reason: "" };
      }
      reason = judged.reason;
      if (judged.actionable) break;
      const answer = await view.ask(
        `The ticket is not ready to build: ${reason}\n\nAdd what is missing, or stop.`,
        z.union([z.enum(["stop"]), z.string()]),
      );
      if (answer === "stop") {
        await view.show(`not actionable: ${reason}`);
        return { actionable: false, reason, branch: "", tasks: [] };
      }
      text = `${text}\n\n# Clarifications\n\n${answer}`;
    }

    const named =
      style.branches.length === 0 ? "" : `\n\n# Recent branch names\n\n${style.branches.join("\n")}`;
    // A ticket can attach a screenshot or a log, so the turn needs Read to open one. Nothing else
    // is on the ticket's path, and none of the person's own CLI setup means no MCP servers to wait
    // on.
    const session = await agent.open({ model: "small", tools: ["Read"], settings: [] });
    let input = `${text}${named}`;
    for (;;) {
      const out = await narrated(view, () =>
        agent.turn(session, { skill: "triage", prompt: input }, { result: Out }),
      );
      const tasks = out.tasks.length === 0 ? [text] : out.tasks;
      const triaged = { actionable: true, reason, branch: out.branch, tasks };
      if (tasks.length === 1) return triaged;
      const listed = tasks.map((task, index) => `${index + 1}. ${task}`).join("\n");
      const answer = await view.ask(
        `The ticket splits into ${tasks.length} tasks:\n\n${listed}\n\nApprove the split?`,
        z.union([z.enum(["approve"]), z.string()]),
      );
      if (answer === "approve") return triaged;
      input = `# The revision the user asks for\n\n${answer}`;
    }
  },
});
