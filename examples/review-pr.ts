import { workflow } from "wa";
import { z } from "zod";

const Findings = z.object({
  verdict: z.enum(["approved", "changes_needed"]),
  report: z.string(),
});

export default workflow({
  description: "review an open pull request into a findings file, then post it as a comment",
  params: z.object({ pr: z.string() }),

  async run({ params, agent, github, view, gate }) {
    const diff = await github.pr.diff(params.pr);
    if (!diff.ok) {
      await gate(`gh pr diff ${params.pr} failed: ${diff.reason}`);
      return { verdict: "unavailable", report: "" };
    }

    const reviewer = agent();
    const review = (await reviewer.run("wa-review-diff", { input: diff.diff, result: Findings }))!;
    view.artifact({ title: "Review findings", path: review.report });
    const answer = await gate(
      `${review.verdict}, findings in ${review.report}. Post the findings to the PR? (post / skip)`,
    );
    if (answer !== "post") return review;

    const posted = await github.pr.comment(params.pr, { bodyFile: review.report });
    if (!posted.ok) await gate(`The comment failed: ${posted.reason}`);
    return review;
  },
});
