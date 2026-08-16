import { workflow } from "wa";
import { z } from "zod";

const Review = z.object({
  verdict: z.enum(["approved", "changes_needed"]),
  findings: z.string(),
});

function quoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export default workflow({
  description: "one small change in this repository: implement, review, then a commit gate",
  params: z.object({ task: z.string() }),

  async run({ params, step, gate }) {
    let approved = false;
    for (let round = 0; round < 3 && !approved; round++) {
      await step.agent("wa-implement", { input: params.task });
      const review = await step.agent("wa-review", { input: params.task, result: Review });
      approved = review.verdict === "approved";
    }
    if (!approved) await gate("Three review rounds. Take a look.");

    if ((await gate("Commit? (commit / leave)")) !== "commit") return;

    await step.command("git add -A");
    const commit = await step.command(`git commit -m ${quoted(params.task)}`);
    if (commit.code !== 0) {
      await gate(`Nothing committed: ${(commit.stdout + commit.stderr).trim()}`);
    }
  },
});
