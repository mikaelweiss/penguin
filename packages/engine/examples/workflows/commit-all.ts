import { call, workflow } from "penguin";
import { z } from "zod";
import commit from "./commit.ts";

export default workflow({
  description: "commit every listed folder, all at once",
  params: z.object({ dirs: z.array(z.string()).min(1) }),

  async run(ctx) {
    const { params, view } = ctx;
    const results = await Promise.all(
      params.dirs.map(async (dir) => ({ dir, done: await call(ctx, commit, { dir }) })),
    );
    const committed = results.filter((entry) => entry.done.committed);
    await view.show(`committed ${committed.length} of ${results.length} folders`);
    return results;
  },
});
