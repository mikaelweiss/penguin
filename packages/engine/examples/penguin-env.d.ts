// Maps each installed adapter role onto ctx, so workflows type-check. Maintained by hand.
import type claude from "./adapters/claude.ts";
import type git from "./adapters/git.ts";
import type view from "./adapters/view.ts";

declare module "penguin" {
  interface Adapters {
    agent: ReturnType<(typeof claude)["build"]>;
    vcs: ReturnType<(typeof git)["build"]>;
    view: ReturnType<(typeof view)["build"]>;
  }
}
