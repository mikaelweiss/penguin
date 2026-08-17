import { workflow } from "penguin";
import { z } from "zod";

const JIRA = /^(?:.*\/browse\/)?([A-Z][A-Z0-9]*-\d+)(?:[/?#].*)?$/;
const GITHUB = /^(?:https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/)?(\d+)(?:[/?#].*)?$/;

const Plan = z.object({
  spec: z.string().describe("path to the markdown file that holds the plan"),
  acceptance: z.string().describe("the acceptance criteria, one per line"),
});

function keyed(pattern: RegExp, ticket: string): string | undefined {
  return pattern.exec(ticket.trim())?.[1];
}

function revision(ticket: string, answer: string): string {
  return `${ticket}\n\n# The revision the user asks for\n\n${answer}`;
}

export default workflow({
  description: "plan a change with feedback and approval from the user",
  params: z.object({ ticket: z.string(), dir: z.string().optional() }),

  async run(ctx) {
    const { params, agent, view, gate } = ctx;

    let ticket = params.ticket;
    const key = keyed(JIRA, ticket);
    const number = keyed(GITHUB, ticket);
    if (key !== undefined) {
      const found = await ctx.jira.issue.get(key);
      if (found.issue === null) throw new Error(`${key} did not read: ${found.reason}`);
      const one = found.issue;
      ticket = `# ${one.key}: ${one.summary}\n\n${one.url}\n\n${one.description}`;
    } else if (number !== undefined) {
      const found = await ctx.github.issue.get(number);
      if (found.issue === null) throw new Error(`#${number} did not read: ${found.reason}`);
      const one = found.issue;
      ticket = `# ${one.title}\n\n${one.url}\n\n${one.body}`;
    }

    const planner = agent({ cwd: params.dir });
    let input = ticket;
    for (;;) {
      const plan = (await planner.run("penguin-plan", {
        input,
        result: Plan,
      }))!;
      view.artifact({ title: "Plan", path: plan.spec });
      const answer = await gate("Type approve, or type what to change.");
      if (answer === "approve") return plan;
      input = revision(ticket, answer);
    }
  },
});
