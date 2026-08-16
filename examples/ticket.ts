import { workflow } from "wa";
import { z } from "zod";

const Triage = z.object({ actionable: z.boolean(), reason: z.string() });
const Plan = z.object({ spec: z.string(), acceptance: z.string() });
const Review = z.object({
  verdict: z.enum(["approved", "changes_needed"]),
  findings: z.string(),
});

export default workflow({
  params: z.object({ ticket: z.string() }),

  async run({ params, step, gate }) {
    const t = await step.agent("./skills/triage.md", { input: params.ticket, result: Triage });
    if (!t.actionable) {
      await gate(`Not actionable: ${t.reason}`);
      return;
    }

    let plan;
    do {
      plan = await step.agent("./skills/plan.md", { input: params.ticket, result: Plan });
    } while ((await gate("Approve the plan? (approve / revise)")) !== "approve");

    const ws = `../wa-${params.ticket}`;
    await step.command(`git worktree add ${ws}`);
    let approved = false;
    for (let round = 0; round < 3 && !approved; round++) {
      await step.agent("./skills/implement.md", { input: plan.spec, cwd: ws });
      const review = await step.agent("./skills/review.md", {
        input: plan.acceptance,
        cwd: ws,
        result: Review,
      });
      approved = review.verdict === "approved";
    }
    if (!approved) await gate("Three review rounds. Take a look.");

    const pr = await step.command("gh pr create --fill", { cwd: ws });
    while ((await gate(`PR is up: ${pr.stdout.trim()} (address-feedback / done)`)) !== "done") {
      await step.agent("./skills/address-feedback.md", { cwd: ws });
    }
  },
});
