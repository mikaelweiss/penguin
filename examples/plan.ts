import { workflow } from "penguin";
import { z } from "zod";

const JIRA = /^(?:.*\/browse\/)?([A-Z][A-Z0-9]*-\d+)(?:[/?#].*)?$/;
const GITHUB =
  /^(?:https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/)?(\d+)(?:[/?#].*)?$/;

const Blocked = z.object({ questions: z.array(z.string()) });
const Plan = z.object({
  plan: z.string().describe("the finished plan, in markdown"),
  acceptance: z.string().describe("the acceptance criteria, one per line"),
});

type Note = { author: string; at: string; body: string };

function keyed(pattern: RegExp, ticket: string): string | undefined {
  return pattern.exec(ticket.trim())?.[1];
}

function withNotes(body: string, notes: Note[]): string {
  if (notes.length === 0) return body;
  const written = notes.map((note) => `## ${note.author} on ${note.at}\n\n${note.body}`);
  return `${body}\n\n# Comments\n\n${written.join("\n\n")}`;
}

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
    const { params, agent, view, gate } = ctx;

    let ticket = params.ticket;
    const key = keyed(JIRA, ticket);
    const number = keyed(GITHUB, ticket);
    if (key !== undefined) {
      const found = await ctx.jira.issue.get(key);
      if (found.issue === null)
        throw new Error(`${key} did not read: ${found.reason}`);
      const one = found.issue;
      const said = await ctx.jira.issue.comments(key);
      if (!said.ok)
        view.event({ level: "warn", message: `${key} comments did not read: ${said.reason}` });
      ticket = withNotes(
        `# ${one.key}: ${one.summary}\n\n${one.url}\n\n${one.description}`,
        said.comments,
      );
    } else if (number !== undefined) {
      const found = await ctx.github.issue.get(number);
      if (found.issue === null)
        throw new Error(`#${number} did not read: ${found.reason}`);
      const one = found.issue;
      const said = await ctx.github.issue.comments(number);
      if (!said.ok)
        view.event({ level: "warn", message: `#${number} comments did not read: ${said.reason}` });
      ticket = withNotes(`# ${one.title}\n\n${one.url}\n\n${one.body}`, said.comments);
    }

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
