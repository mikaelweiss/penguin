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
  let ws = await ctx.vcs.worktree.add(name, options);
  while (!ws.ok) {
    // A failure nothing can answer still gets read, so the run does not end on a line nobody saw.
    if (!ws.exists) {
      await ctx.view.ask(`The worktree failed: ${ws.reason}`, z.union([z.enum(["ok"]), z.string()]));
      return "";
    }
    const choice = await ctx.view.ask(
      `A worktree already sits at ${ws.path}. Type use to work in it, replace to delete it and cut a fresh one, or exit to stop.`,
      Choice,
    );
    if (choice === "exit") return "";
    if (choice === "use") return ws.path;
    const gone = await ctx.vcs.worktree.remove(ws.path, { force: true });
    // The delete failing leaves the same worktree in the way, so the ask comes round again.
    if (!gone.ok) {
      await ctx.view.show(`The worktree did not delete: ${gone.reason}`);
      continue;
    }
    ws = await ctx.vcs.worktree.add(name, options);
  }
  return ws.path;
}
