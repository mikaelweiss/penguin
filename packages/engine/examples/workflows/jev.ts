import path from "node:path";
import { workflow } from "penguin";
import { z } from "zod";
import { comment } from "../helpers/jev.ts";

/** Jev reads one file at a time, so the change goes over whole, not at the cut an agent's prompt takes. */
const WHOLE = 50_000_000;

export default workflow({
  description:
    "screen the uncommitted change with Jev: five concerns per file with the code around it as context, the strongest cells followed into their hunks, the report shown here in seconds",
  params: z.object({
    dir: z.string().default(".").describe("the checkout to screen, the current folder by default"),
  }),

  async run({ jev, params, vcs, view }) {
    const dir = path.resolve(params.dir);
    const diff = await vcs.diff({ cwd: dir, untracked: true, limit: WHOLE });
    if (diff.text.trim() === "") {
      await view.show("the tree holds no change to screen");
      return { files: 0, findings: 0 };
    }
    const report = await jev.review({ dir, diff: diff.text });
    if (report === null) {
      await view.show("the change holds nothing for Jev to screen");
      return { files: 0, findings: 0 };
    }
    await view.show(comment(report, "the working tree"));
    return { files: report.files, findings: report.findings.length };
  },
});
