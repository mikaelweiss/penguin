import { workflow } from "wa";
import { z } from "zod";

const Review = z.object({
  verdict: z.enum(["approved", "changes_needed"]),
  findings: z.string(),
});

function brief(task: string, findings: string[]): string {
  const last = findings.at(-1);
  if (last === undefined) return task;
  return `${task}\n\n# Review findings to address\n\n${last}`;
}

function checklist(task: string, findings: string[]): string {
  if (findings.length === 0) return task;
  return `${task}\n\n# Prior review findings\n\nMake sure each one is fixed, then look wider.\n\n${findings.join("\n\n")}`;
}

export default workflow({
  description: "one small change in this repository: implement, review, then a commit gate",
  params: z.object({ task: z.string() }),

  async run({ params, agent, vcs, view, gate }) {
    view.watch({ elapsed: true, diff: "." });
    const implementer = agent();
    const findings: string[] = [];
    let approved = false;

    for (let round = 1; round <= 3 && !approved; round++) {
      approved = await view.activity(`round ${round} of 3`, async () => {
        view.fact({ round: `${round}/3` });
        await implementer.run("wa-implement", { input: brief(params.task, findings) });
        const reviewer = agent();
        const review = (await reviewer.run("wa-review", {
          input: checklist(params.task, findings),
          result: Review,
        }))!;
        findings.push(review.findings);
        view.fact({ verdict: review.verdict });
        return review.verdict === "approved";
      });
    }
    if (!approved) await gate("Three review rounds. Take a look.");

    if ((await gate("Commit? (commit / leave)")) !== "commit") return;

    await vcs.stageAll();
    const commit = await vcs.commit(params.task);
    if (!commit.ok) await gate(`Nothing committed: ${commit.reason}`);
  },
});
