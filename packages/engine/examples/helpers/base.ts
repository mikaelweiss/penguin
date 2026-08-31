import type { Ctx } from "penguin";
import { z } from "zod";

const Branch = z.union([z.enum(["stop"]), z.string()]);

/** The base branch: what the caller named, else what origin calls default, else what a person names. */
export async function resolveBase(ctx: Ctx<unknown>, given: string): Promise<string> {
  const named = given.trim();
  if (named !== "") return named;
  const found = await ctx.vcs.defaultBranch();
  if (found.branch !== "") return found.branch;
  const answer = await ctx.view.ask("origin names no default branch. Name the base branch, or stop.", Branch);
  return answer === "stop" ? "" : answer.trim();
}
