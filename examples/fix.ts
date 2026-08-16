import { workflow } from "wa";
import { z } from "zod";

const Reproduce = z.object({ reproduced: z.boolean(), notes: z.string() });
const Verify = z.object({ passing: z.boolean(), details: z.string() });

export default workflow({
  params: z.object({ bug: z.string() }),

  async run({ params, step, gate }) {
    const repro = await step.agent("wa-reproduce", { input: params.bug, result: Reproduce });
    if (!repro.reproduced) {
      await gate(`Not reproduced: ${repro.notes}`);
      return;
    }

    let passing = false;
    for (let round = 0; round < 3 && !passing; round++) {
      await step.agent("wa-implement", { input: `${params.bug}\n\n${repro.notes}` });
      const checks = await step.agent("wa-verify", { result: Verify });
      passing = checks.passing;
    }
    if (!passing) await gate("Three fix rounds. The checks still fail. Take a look.");

    const pr = await step.command("gh pr create --fill");
    while ((await gate(`PR is up: ${pr.stdout.trim()} (address-feedback / done)`)) !== "done") {
      await step.agent("wa-address-feedback");
    }
  },
});
