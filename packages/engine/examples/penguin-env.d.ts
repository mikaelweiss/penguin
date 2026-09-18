// Maps each installed adapter role onto ctx, so workflows type-check. Maintained by hand.
import type { View } from "penguin";
import type brief from "./adapters/brief.ts";
import type claude from "./adapters/claude.ts";
import type gates from "./adapters/gates.ts";
import type gh from "./adapters/gh.ts";
import type git from "./adapters/git.ts";
import type jev from "./adapters/jev.ts";
import type jira from "./adapters/jira.ts";

declare module "penguin" {
  interface Adapters {
    agent: ReturnType<(typeof claude)["build"]>;
    brief: ReturnType<(typeof brief)["build"]>;
    gates: ReturnType<(typeof gates)["build"]>;
    github: ReturnType<(typeof gh)["build"]>;
    jev: ReturnType<(typeof jev)["build"]>;
    jira: ReturnType<(typeof jira)["build"]>;
    vcs: ReturnType<(typeof git)["build"]>;
    view: View;
  }
}
