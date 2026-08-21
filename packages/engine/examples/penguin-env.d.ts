// Maps each installed adapter role onto ctx, so workflows type-check. Maintained by hand.
import type git from "./adapters/git.ts";

declare module "penguin" {
  interface Adapters {
    vcs: ReturnType<(typeof git)["build"]>;
  }
}
