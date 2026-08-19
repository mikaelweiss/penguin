import { workflow } from "penguin";
import { z } from "zod";
import reviewPr from "./review-pr.ts";

type Requested = { number: number; title: string };

export default workflow({
  description:
    "watch the pull requests that ask for your review, and run a review on each one as it arrives",
  params: z.object({ reviewer: z.string().default("@me") }),

  async run(ctx) {
    const { params, github, view } = ctx;
    const requests = await github.pr.requested(params.reviewer);
    const reviewing = new Set<number>();
    let taken = 0;
    let ended = 0;

    const counted = (): void =>
      view.fact({ reviewing: reviewing.size, taken, ended });

    // A review lives until you approve its PR or it closes, so it runs beside the watch, never in front of it.
    const take = (request: Requested): void => {
      reviewing.add(request.number);
      taken += 1;
      view.event({
        message: `PR #${request.number} asks for a review: ${request.title}`,
      });
      counted();
      void reviewPr(ctx, { pr: String(request.number) })
        .catch((error: unknown) => {
          view.event({
            level: "error",
            message: `The review of PR #${request.number} failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        })
        .finally(() => {
          reviewing.delete(request.number);
          ended += 1;
          counted();
        });
    };

    counted();
    for (;;) {
      const request = await requests.next();
      if (!reviewing.has(request.number)) take(request);
    }
  },
});
