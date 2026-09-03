import { workflow } from "penguin";
import { z } from "zod";
import { narrated } from "../helpers/turns.ts";

/** Read and search only. The tree is finished; a walkthrough that edits it is a change nobody reviewed. */
const TOOLS = ["Read", "Grep", "Glob", "Bash"];

export const Walkthrough = z.object({
  open: z
    .string()
    .describe(
      "the one line that lands the person on the spot: for a web app the full local URL to paste into a browser, otherwise the app to launch and the taps or clicks to the screen",
    ),
  steps: z
    .array(z.string())
    .describe(
      "what to do once there, one action per entry, naming things as the screen shows them; empty when arriving is enough",
    ),
  expect: z
    .string()
    .describe("what looks or behaves differently now, and what would mean the change failed"),
});

export type Walkthrough = z.infer<typeof Walkthrough>;

/** The walkthrough as the person reads it at the gate. */
export function render(found: Walkthrough): string {
  const parts = [`Open: ${found.open.trim()}`];
  if (found.steps.length > 0) {
    parts.push(found.steps.map((step, index) => `${index + 1}. ${step.trim()}`).join("\n"));
  }
  parts.push(`Expect: ${found.expect.trim()}`);
  return parts.join("\n\n");
}

function brief(
  acceptance: string,
  base: string,
  diff: { text: string; truncated: boolean },
): string {
  const cut = diff.truncated ? " It was cut here, so read the rest with that command." : "";
  return [
    `# What the change is for\n\n${acceptance}`,
    `# The change\n\n\`git diff ${base}...HEAD\`, read off the tree for you.${cut}\n\n${diff.text}`,
  ].join("\n\n");
}

export default workflow({
  description:
    "write the steps a person follows to see a change working: where to open it, what to do, what to expect",
  params: z.object({
    acceptance: z
      .string()
      .describe("what the change has to satisfy, one check per line")
      .meta({ multiline: true }),
    base: z.string().describe("the commit or branch the change started from"),
  }),

  async run({ params, agent, vcs, view }) {
    // The diff rides in the prompt, so the turn starts reading code instead of asking git for it.
    const diff = await vcs.against(params.base);
    const session = await agent.open({ tools: TOOLS });
    const found = await narrated(view, () =>
      agent.turn(
        session,
        { skill: "walkthrough", prompt: brief(params.acceptance, params.base, diff) },
        { result: Walkthrough },
      ),
    );
    return { walkthrough: render(found) };
  },
});
