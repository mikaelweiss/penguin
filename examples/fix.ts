import { workflow } from "wa";
import { z } from "zod";

const Reproduce = z.object({ reproduced: z.boolean(), notes: z.string() });
const Verify = z.object({ passing: z.boolean(), details: z.string() });

export default workflow({
  description: "reproduce a bug, fix it against the repo checks, then the pull request",
  params: z.object({ bug: z.string() }),

  async run({ params, agent, github, view, gate }) {
    const investigator = agent();
    const repro = await investigator.run("wa-reproduce", { input: params.bug, result: Reproduce });
    if (!repro.reproduced) {
      await gate(`Not reproduced: ${repro.notes}`);
      return;
    }

    view.watch({ elapsed: true, diff: "." });
    const implementer = agent();
    let passing = false;
    for (let round = 1; round <= 3 && !passing; round++) {
      view.fact({ round: `${round}/3` });
      await implementer.run("wa-implement", { input: `${params.bug}\n\n${repro.notes}` });
      const verifier = agent();
      const checks = await verifier.run("wa-verify", { result: Verify });
      passing = checks.passing;
    }
    if (!passing) await gate("Three fix rounds. The checks still fail. Take a look.");

    const pr = await github.pr.create();
    if (!pr.ok) {
      await gate(`No pull request: ${pr.reason}`);
      return;
    }
    view.artifact({ title: "Pull request", url: pr.url });
    while ((await gate(`PR is up: ${pr.url} (address-feedback / done)`)) !== "done") {
      const fixer = agent();
      await fixer.run("wa-address-feedback");
    }
  },
});
