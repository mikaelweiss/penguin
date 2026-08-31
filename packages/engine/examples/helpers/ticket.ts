import type { Ctx } from "penguin";

const JIRA = /^(?:.*\/browse\/)?([A-Z][A-Z0-9]*-\d+)(?:[/?#].*)?$/;
const GITHUB =
  /^(?:https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/)?(\d+)(?:[/?#].*)?$/;

type Note = { author: string; at: string; body: string };

function keyed(pattern: RegExp, ticket: string): string | undefined {
  return pattern.exec(ticket.trim())?.[1];
}

function withNotes(body: string, notes: Note[]): string {
  if (notes.length === 0) return body;
  const written = notes.map((note) => `## ${note.author} on ${note.at}\n\n${note.body}`);
  return `${body}\n\n# Comments\n\n${written.join("\n\n")}`;
}

/** A Jira key or a GitHub issue number is fetched to text, anything else is the text itself. */
export async function resolveTicket(ctx: Ctx<unknown>, ticket: string): Promise<string> {
  const key = keyed(JIRA, ticket);
  const number = keyed(GITHUB, ticket);
  if (key !== undefined) {
    const one = await ctx.jira.issue.get(key);
    const notes = await ctx.jira.issue.comments(key);
    return withNotes(`# ${one.key}: ${one.summary}\n\n${one.url}\n\n${one.description}`, notes);
  }
  if (number !== undefined) {
    const one = await ctx.github.issue.get(number);
    const notes = await ctx.github.issue.comments(number);
    return withNotes(`# ${one.title}\n\n${one.url}\n\n${one.body}`, notes);
  }
  return ticket;
}
