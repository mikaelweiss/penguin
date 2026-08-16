import { workflow } from "wa";
import { z } from "zod";

const Triage = z.object({ actionable: z.boolean(), reason: z.string() });
const Plan = z.object({ spec: z.string(), acceptance: z.string() });
const Review = z.object({
  verdict: z.enum(["approved", "changes_needed"]),
  findings: z.string(),
});

function checklist(acceptance: string, findings: string[]): string {
  if (findings.length === 0) return acceptance;
  return `${acceptance}\n\n# Prior review findings\n\nMake sure each one is fixed, then look wider.\n\n${findings.join("\n\n")}`;
}

export default workflow({
  description: "ticket to merged PR: triage, plan, implement, review, then the pull request",
  params: z.object({ ticket: z.string() }),

  async run({ params, agent, vcs, github, view, gate }) {
    const triager = agent();
    const t = await triager.run("wa-triage", { input: params.ticket, result: Triage });
    if (!t.actionable) {
      await gate(`Not actionable: ${t.reason}`);
      return;
    }

    const planner = agent();
    let plan;
    do {
      plan = await planner.run("wa-plan", { input: params.ticket, result: Plan });
    } while ((await gate("Approve the plan? (approve / revise)")) !== "approve");

    const ws = await vcs.worktree.add(`wa-${params.ticket}`);
    if (!ws.ok) {
      await gate(`No worktree: ${ws.reason}`);
      return;
    }
    view.watch({ elapsed: true, diff: ws.path });

    const implementer = agent({ cwd: ws.path });
    const findings: string[] = [];
    let approved = false;
    for (let round = 1; round <= 3 && !approved; round++) {
      approved = await view.activity(`round ${round} of 3`, async () => {
        view.fact({ round: `${round}/3` });
        await implementer.run("wa-implement", {
          input: findings.length === 0 ? plan.spec : checklist(plan.spec, findings.slice(-1)),
        });
        const reviewer = agent({ cwd: ws.path });
        const review = await reviewer.run("wa-review", {
          input: checklist(plan.acceptance, findings),
          result: Review,
        });
        findings.push(review.findings);
        view.fact({ verdict: review.verdict });
        return review.verdict === "approved";
      });
    }
    if (!approved) await gate("Three review rounds. Take a look.");

    const pr = await github.pr.create({ cwd: ws.path });
    if (!pr.ok) {
      await gate(`No pull request: ${pr.reason}`);
      return;
    }
    view.artifact({ title: "Pull request", url: pr.url });
    while ((await gate(`PR is up: ${pr.url} (address-feedback / done)`)) !== "done") {
      const fixer = agent({ cwd: ws.path });
      await fixer.run("wa-address-feedback");
    }
  },
});
