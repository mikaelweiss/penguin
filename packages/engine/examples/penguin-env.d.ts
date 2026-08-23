// Maps each installed adapter role onto ctx, so workflows type-check. Maintained by hand.
import type { View } from "penguin";
import type claude from "./adapters/claude.ts";
import type git from "./adapters/git.ts";

declare module "penguin" {
  interface Adapters {
    agent: ReturnType<(typeof claude)["build"]>;
    vcs: ReturnType<(typeof git)["build"]>;
    view: View;
  }
}
