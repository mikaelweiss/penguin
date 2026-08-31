import { workflow } from "penguin";
import { z } from "zod";
import { narrated } from "../helpers/turns.ts";

const Commit = z.object({
  files: z
    .array(z.string())
    .describe("the paths to commit, as git status prints them, empty when nothing belongs in one"),
  message: z.string().describe("the commit message, the title on the first line"),
});

export default workflow({
  description: "commit the work in the tree: the agent picks the files and writes the message",
  params: z.object({}),

  async run({ agent, vcs, view }) {
    if (!(await vcs.dirty()).dirty) {
      await view.show("nothing to commit");
      return { committed: false, message: "" };
    }

    const session = await agent.open();
    const written = await narrated(view, () =>
      agent.turn(session, { skill: "commit" }, { result: Commit }),
    );
    if (written.files.length === 0) {
      await view.show("nothing worth committing");
      return { committed: false, message: written.message };
    }

    await vcs.stage(written.files);
    await vcs.commit(written.message);
    await view.show(`committed: ${written.message.split("\n")[0]}`);
    return { committed: true, message: written.message };
  },
});
