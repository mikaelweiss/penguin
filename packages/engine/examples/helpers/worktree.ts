import type { Ctx } from "penguin";
import { z } from "zod";

const Choice = z.enum(["use", "replace", "exit"]);

/**
 * A worktree for name, settling with the person when one already holds it. Empty means they chose
 * to stop, so the caller ends its run rather than work in a checkout it did not cut itself.
 */
export async function openWorktree(
  ctx: Ctx<unknown>,
  name: string,
  options?: { ref?: string; from?: string },
): Promise<string> {
  for (;;) {
    const ws = await ctx.vcs.worktree.add(name, options);
    if (!ws.existed) return ws.path;
    const choice = await ctx.view.ask(
      `A worktree already sits at ${ws.path}. use works in it, replace deletes it and cuts a fresh one, exit stops.`,
      Choice,
    );
    if (choice === "exit") return "";
    if (choice === "use") return ws.path;
    await ctx.vcs.worktree.remove(ws.path, { force: true });
  }
}
