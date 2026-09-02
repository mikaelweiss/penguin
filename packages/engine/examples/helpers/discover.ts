import type { Ctx } from "penguin";
import { z } from "zod";
import { narrated } from "./turns.ts";

/** Read and search only. A scout that can edit is an implementer on the wrong model. */
const TOOLS = ["Read", "Grep", "Glob", "Bash"];

/** A dumped search fails the schema here instead of crossing into the expensive session. */
const MOST = 40;

export const Scouted = z.object({
  files: z
    .array(z.string())
    .max(MOST)
    .describe(
      "the repo-relative paths worth opening for this task, most important first. What the work edits, and what has to be read for it to be written right. Not everything you opened.",
    ),
  found: z
    .string()
    .describe("how the code stands today where this task lands, a few lines, no file listing"),
  missing: z
    .string()
    .describe("what you looked for and could not find, empty when nothing is missing"),
});

export type Bearings = z.infer<typeof Scouted>;

function ask(task: string): string {
  return [
    `# The task\n\n${task}`,
    `# What you are for

You are the scout. Another session does this work, on a model that costs many times what yours does, and everything it reads to find its way it pays for again on every request it makes after. Your one job is to hand it the files, so it opens code instead of hunting for it.

You never edit. You have Read, Grep, Glob, and Bash, and Bash is for searching and listing only: no editor, no redirect into a file, no git command that changes anything.`,
    `# What to hand back

Read enough of what you find to be sure of it. A path you cannot give a reason for costs the next session more than it saves.

Return the paths worth opening, most important first: what the change edits, the tests that cover it, the types it crosses, the callers it moves under, and the one place already doing this well enough to copy. Leave out what you only passed through. Forty paths is the search repeated, not spared.

Say what you could not find. A file the next session should expect and you could not locate is worth more to it than a guess at where it might be.

Search in batches. Every tool call sends this whole conversation again, so ten small greps cost ten times one grep over the same ground.`,
  ].join("\n\n");
}

/** One cheap turn finds the files, so the working session opens code instead of hunting for it. */
export async function discover(
  ctx: Ctx<unknown>,
  options: { task: string; cwd?: string },
): Promise<Bearings> {
  const session = await ctx.agent.open({
    model: "small",
    tools: TOOLS,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
  const scouted = await narrated(ctx.view, () =>
    ctx.agent.turn(session, ask(options.task), { result: Scouted }),
  );
  const files = [...new Set(scouted.files.map((one) => one.trim()).filter((one) => one !== ""))];
  return { ...scouted, files };
}

export function bearings(scouted: Bearings): string {
  if (scouted.files.length === 0 && scouted.missing === "") return "";
  const parts: string[] = [];
  if (scouted.files.length > 0) {
    parts.push(
      `# The files this task works in\n\nA scout read the repository and found these. Open them before you search for anything: that search is already paid for.\n\n${scouted.files.map((one) => `- ${one}`).join("\n")}`,
    );
  }
  if (scouted.found !== "") parts.push(`# How the code stands there\n\n${scouted.found}`);
  if (scouted.missing !== "")
    parts.push(
      `# What the scout could not find\n\nThese are unsearched, not absent. Look for them yourself if the task needs them.\n\n${scouted.missing}`,
    );
  return parts.join("\n\n");
}
