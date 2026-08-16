import { workflow } from "wa";
import { z } from "zod";

const Findings = z.object({
  verdict: z.enum(["approved", "changes_needed"]),
  report: z.string(),
});

export default workflow({
  description: "review an open pull request into a findings file, then post it as a comment",
  params: z.object({ pr: z.string() }),

  async run({ params, step, gate }) {
    const diff = await step.command(`gh pr diff ${params.pr}`);
    if (diff.code !== 0) {
      await gate(`gh pr diff ${params.pr} failed: ${diff.stderr.trim()}`);
      return;
    }

    const review = await step.agent("wa-review-diff", { input: diff.stdout, result: Findings });
    const answer = await gate(
      `${review.verdict}, findings in ${review.report}. Post the findings to the PR? (post / skip)`,
    );
    if (answer !== "post") return;

    await step.command(`gh pr comment ${params.pr} --body-file ${review.report}`);
  },
});
