import { workflow } from "penguin";
import { z } from "zod";
import { narrated } from "../helpers/turns.ts";

/** Enough subject lines to read a repository's style off, few enough to stay cheap. */
const STYLE_DEPTH = 20;

/** git's own ceiling for a subject line. The skill asks for 50; this is where it stops being one. */
const SUBJECT_LIMIT = 72;

function section(name: string, body: string): string {
  return `<${name}>\n${body.trim()}\n</${name}>`;
}

export default workflow({
  description: "commit the work in the tree: the agent picks the files and writes the message",
  params: z.object({}),

  async run({ agent, vcs, view }) {
    const { files } = await vcs.status();
    if (files.length === 0) {
      await view.show("nothing to commit");
      return { committed: false, message: "" };
    }

    // The turn reads the tree from the prompt. Left to fetch it, an agent spends a
    // round trip per command, and the commit costs half a minute instead of seconds.
    const [diff, style] = await Promise.all([
      vcs.diff({ untracked: true }),
      vcs.subjects(STYLE_DEPTH),
    ]);
    const tree = [
      section("status", files.map((file) => `${file.status} ${file.path}`).join("\n")),
      section(
        "diff",
        diff.truncated
          ? `${diff.text}\n\n… cut here. The status list is the whole change.`
          : diff.text,
      ),
      section("recent_subjects", style.subjects.join("\n")),
    ].join("\n\n");

    // Every constraint the answer has to meet is in the schema, so the CLI holds the
    // model to it as it writes: only paths git just reported, and a subject short
    // enough to read as one. The workflow lays the message out itself.
    const paths = files.map((file) => file.path) as [string, ...string[]];
    const Commit = z.object({
      files: z
        .array(z.enum(paths))
        .describe("the paths to commit, empty when nothing belongs in one"),
      subject: z.string().max(SUBJECT_LIMIT).describe("the commit title, under 50 characters"),
      body: z.string().describe("why the change is right, empty when the diff already shows it"),
    });

    // The tree is in the prompt, so this turn only answers. No tools and none of the
    // person's own CLI setup means no tool definitions to send and no MCP servers to
    // wait on, which is nearly all of what the turn used to spend. Low effort suits
    // the job: picking files and naming a change is judgment, not deliberation.
    const session = await agent.open({
      model: "small",
      tools: [],
      settings: [],
      effort: "low",
    });
    const written = await narrated(view, () =>
      agent.turn(session, { skill: "commit", prompt: tree }, { result: Commit }),
    );
    const body = written.body.trim();
    const message = body === "" ? written.subject : `${written.subject}\n\n${body}`;
    if (written.files.length === 0) {
      await view.show("nothing worth committing");
      return { committed: false, message };
    }

    await vcs.stage(written.files);
    const wrote = await vcs.commit(message);
    if (!wrote.committed) {
      await view.show("the picked files held no changes");
      return { committed: false, message };
    }
    await view.show(`committed: ${written.subject}`);
    return { committed: true, message };
  },
});
