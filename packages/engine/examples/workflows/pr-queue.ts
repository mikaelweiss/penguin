import { call, messageOf, workflow } from "penguin";
import { z } from "zod";
import reviewPr from "./review-pr.ts";

export default workflow({
  description:
    "watch the pull requests that ask for your review, and run a review on each one as it arrives",
  params: z.object({ reviewer: z.string().default("@me") }),

  async run(ctx) {
    const { params, github, view } = ctx;
    const requests = github.pr.requested(params.reviewer);
    const reviewing = new Set<number>();

    for (;;) {
      await view.show("waiting for review requests", { kind: "waiting" });
      const request = await requests.next();
      if (reviewing.has(request.number)) continue;
      reviewing.add(request.number);
      await view.show(`PR #${request.number} asks for a review: ${request.title}`);
      // A review lives until you approve its PR or it closes, so it runs beside the watch, never in front of it.
      void call(ctx, reviewPr, { pr: String(request.number) })
        .catch(async (error: unknown) => {
          await view.show(`The review of PR #${request.number} failed: ${messageOf(error)}`);
        })
        .finally(() => {
          reviewing.delete(request.number);
        });
    }
  },
});
