import { workflow } from "penguin";
import { z } from "zod";

const Commit = z.object({
  files: z
    .array(z.string())
    .describe("the paths to commit, as git status prints them, empty when nothing belongs in one"),
  message: z.string().describe("the commit message, the title on the first line"),
});

const PICK = `
# Pick the files and write the message

Choose what this commit holds and write its message. Do not stage the files. Do not commit. penguin does both after you answer.

1. Read the tree: \`git status --porcelain\`, then \`git diff\` for the tracked changes.
2. Read every untracked file before you decide on it. \`git diff\` does not show it, and listing it still commits it.
3. Pick the files that belong to the work, each path exactly as \`git status --porcelain\` prints it. A deleted path commits the deletion. Leave out scratch files, logs, build output, and anything that holds a secret. When nothing belongs in a commit, answer an empty list.
4. Read the last twenty subject lines: \`git log --oneline -20\`. They are the style to match.
5. Write the title. Match the repository style: its prefix convention, its mood, and its length. Say what the change does, under 50 characters, imperative, no period.
6. Write a body only when the diff does not show why the change is right. One short paragraph.
7. Put the paths in \`files\` and the whole message in \`message\`, the title on the first line, a blank line before a body.

The diff already says what changed. A body says why. Never list the files. Never add a footer or a signature.
`;

export default workflow({
  description: "commit the work in the tree: the agent picks the files and writes the message",
  params: z.object({ dir: z.string().optional() }),

  async run({ params, agent, vcs, view }) {
    const state = await vcs.dirty({ cwd: params.dir });
    if (!state.ok) {
      await view.show(`commit failed: ${state.reason}`);
      return { ok: false, committed: false, message: "", reason: state.reason };
    }
    if (!state.dirty) {
      await view.show("nothing to commit");
      return { ok: true, committed: false, message: "", reason: state.reason };
    }

    const session = await agent.open({ cwd: params.dir });
    const turn = agent.turn(session, PICK, { result: Commit });
    for await (const chunk of turn.output) {
      if (chunk.kind === "text") await view.show(chunk.text);
      if (chunk.kind === "tool") await view.show(`  ${chunk.text}: ${chunk.detail ?? ""}`);
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

    const staged = await vcs.stage(written.files, { cwd: params.dir });
    if (!staged.ok) {
      await view.show(`staging failed: ${staged.reason}`);
      return { ok: false, committed: false, message: written.message, reason: staged.reason };
    }

    const done = await vcs.commit(written.message, { cwd: params.dir });
    await view.show(done.ok ? `committed: ${written.message.split("\n")[0]}` : `commit failed: ${done.reason}`);
    return { ok: done.ok, committed: done.ok, message: written.message, reason: done.reason };
  },
});
