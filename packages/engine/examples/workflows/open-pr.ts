import { workflow } from "penguin";
import { z } from "zod";
import commit from "./commit.ts";

const Ack = z.union([z.enum(["ok"]), z.string()]);
const Confirm = z.union([z.enum(["ok", "stop"]), z.string()]);
const Retry = z.union([z.enum(["retry", "stop"]), z.string()]);
const Feedback = z.union([z.enum(["address-feedback", "done"]), z.string()]);
const Description = z.object({
  title: z.string().describe("the pull request title, one line"),
  body: z.string().describe("the pull request body, markdown, empty when the title says it all"),
});

export default workflow({
  description: "open the pull request and answer its review feedback",
  params: z.object({ dir: z.string().optional() }),

  async run(ctx) {
    const { params, agent, github, vcs, view, gate } = ctx;

    const head = await vcs.head({ cwd: params.dir });
    if (!head.ok) {
      await gate(`The checkout did not read: ${head.reason}`, Ack);
      return { url: "" };
    }
    if (head.detached) {
      await gate(
        "The checkout is detached, so there is no branch to push. Check out a branch, then run open-pr again.",
        Ack,
      );
      return { url: "" };
    }
    const base = await vcs.defaultBranch({ cwd: params.dir });
    if (base.ok && head.branch === base.branch) {
      for (;;) {
        const answer = await gate(
          `The checkout is on ${head.branch}, the repository's default branch. Reply ok to open the pull request from it anyway, or stop.`,
          Confirm,
        );
        if (answer === "stop") return { url: "" };
        if (answer === "ok") break;
      }
    }

    // The pull request reads the remote, so every local change goes up before it is asked for.
    async function send(): Promise<{ ok: boolean; reason: string }> {
      const wrote = await commit(ctx, { dir: params.dir });
      if (!wrote.ok) return { ok: false, reason: wrote.reason };
      return vcs.push(head.branch, { cwd: params.dir });
    }

    // What blocks a send is often a person's to fix, so the gate retries instead of ending the run.
    async function delivered(): Promise<boolean> {
      for (;;) {
        const sent = await send();
        if (sent.ok) return true;
        for (;;) {
          const answer = await gate(
            `The branch did not reach the remote: ${sent.reason}\n\nFix it and reply retry, or stop.`,
            Retry,
          );
          if (answer === "stop") return false;
          if (answer === "retry") break;
        }
      }
    }

    if (!(await delivered())) return { url: "" };

    const written = (await agent({ cwd: params.dir }).run("penguin-open-pr", {
      result: Description,
    }))!;
    let pr = await github.pr.create({
      cwd: params.dir,
      title: written.title,
      body: written.body,
    });
    while (!pr.ok) {
      for (;;) {
        const answer = await gate(`No pull request: ${pr.reason}\n\nFix it and reply retry, or stop.`, Retry);
        if (answer === "stop") return { url: "" };
        if (answer === "retry") break;
      }
      pr = await github.pr.create({
        cwd: params.dir,
        title: written.title,
        body: written.body,
      });
    }

    view.artifact({ title: "Pull request", url: pr.url });

    for (;;) {
      const answer = await gate(
        `PR is up: ${pr.url}\n\nReply done to end the run, address-feedback to answer the review threads, or say what to change.`,
        Feedback,
      );
      if (answer === "done") break;
      const asked = answer === "address-feedback" ? "Answer the open review threads." : answer;
      await agent({ cwd: params.dir }).run("penguin-address-feedback", {
        input: `# Pull request\n\n${pr.url}\n\n# What to do\n\n${asked}`,
      });
      if (!(await delivered())) return { url: pr.url };
    }
    return { url: pr.url };
  },
});
