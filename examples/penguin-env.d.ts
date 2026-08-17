// penguin writes this file from the installed adapters. Do not edit.
import type adapter0 from "./adapters/gh.ts";
import type adapter1 from "./adapters/git.ts";

declare module "penguin" {
  interface Adapters {
    github: ReturnType<(typeof adapter0)["build"]>;
    vcs: ReturnType<(typeof adapter1)["build"]>;
  }
}
