import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "run one agent turn that a user message can stop mid-flight",
  params: z.object({ prompt: z.string(), dir: z.string().optional() }),

  async run({ params, agent, view }) {
    const session = await agent.open({ cwd: params.dir });
    const turn = agent.turn(session, params.prompt);
    const narration = (async () => {
      for await (const chunk of turn.output) {
        if (chunk.kind === "text") await view.show(chunk.text);
        if (chunk.kind === "tool") await view.show(`  ${chunk.text}: ${chunk.detail ?? ""}`);
      }
    })();

    const messages = view.listen()[Symbol.asyncIterator]();
    const heard = await Promise.race([
      turn.value.then(
        () => undefined,
        () => undefined,
      ),
      messages.next().then((result) => (result.done === true ? undefined : result.value)),
    ]);
    await messages.return?.(undefined);

    if (heard !== undefined) {
      await agent.stop(session);
      await narration;
      await view.show(`stopped: ${heard.text}`);
      return { finished: false, heardMessage: heard.text };
    }
    await narration;
    const finished = await turn.value.then(
      () => true,
      () => false,
    );
    return { finished, heardMessage: "" };
  },
});
