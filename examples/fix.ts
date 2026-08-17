import { workflow } from "penguin";
import { z } from "zod";
import pr from "./pr.ts";
import verify from "./verify.ts";

const Reproduce = z.object({ reproduced: z.boolean(), notes: z.string() });

function brief(bug: string, notes: string, failures: string): string {
  const report = `${bug}\n\n${notes}`;
  if (failures === "") return report;
  return `${report}\n\n# The checks that still fail\n\n${failures}`;
}

export default workflow({
  description: "reproduce a bug, fix it against the repo checks, then the pull request",
  params: z.object({ bug: z.string(), rounds: z.number().int().min(1).default(3) }),

  async run(ctx) {
    const { params, agent, view, gate } = ctx;
    const investigator = agent();
    const repro = (await investigator.run("penguin-reproduce", {
      input: params.bug,
      result: Reproduce,
    }))!;
    if (!repro.reproduced) {
      await gate(`Not reproduced: ${repro.notes}`);
      return;
    }

    view.watch({ elapsed: true, diff: "." });
    const implementer = agent();
    let failures = "";
    let passing = false;

    for (let round = 1; round <= params.rounds && !passing; round++) {
      passing = await view.activity(`round ${round} of ${params.rounds}`, async () => {
        view.fact({ round: `${round}/${params.rounds}` });
        await implementer.run("penguin-implement", {
          input: brief(params.bug, repro.notes, failures),
        });
        const checks = await verify(ctx, {});
        failures = checks.details;
        return checks.passing;
      });
    }
    if (!passing) await gate("The checks still fail. Take a look.");

    return pr(ctx, {});
  },
});
