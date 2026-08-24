import { workflow } from "penguin";
import { z } from "zod";

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
    const state = await vcs.dirty();
    if (!state.ok) {
      await view.show(`commit failed: ${state.reason}`);
      return { ok: false, committed: false, message: "", reason: state.reason };
    }
    if (!state.dirty) {
      await view.show("nothing to commit");
      return { ok: true, committed: false, message: "", reason: "" };
    }

    const session = await agent.open();
    const turn = agent.turn(session, { skill: "commit" }, { result: Commit });
    for await (const chunk of turn.output) {
      if (chunk.kind === "text") await view.show(chunk.text);
      if (chunk.kind === "tool")
        await view.show(`${chunk.text}: ${chunk.detail ?? ""}`, { kind: "tool" });
    }
    const written = await turn.value;
    if (written.files.length === 0) {
      await view.show("nothing worth committing");
      return {
        ok: true,
        committed: false,
        message: written.message,
        reason: "the agent picked no files",
      };
    }

    const staged = await vcs.stage(written.files);
    if (!staged.ok) {
      await view.show(`staging failed: ${staged.reason}`);
      return { ok: false, committed: false, message: written.message, reason: staged.reason };
    }

    const done = await vcs.commit(written.message);
    await view.show(done.ok ? `committed: ${written.message.split("\n")[0]}` : `commit failed: ${done.reason}`);
    return { ok: done.ok, committed: done.ok, message: written.message, reason: done.reason };
  },
});
