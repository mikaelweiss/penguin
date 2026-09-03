import fs from "node:fs";
import path from "node:path";
import { adapter } from "penguin";
import { gatesFor, parseGates, reportOf, tail, type Ran } from "../helpers/gates.ts";

type Result = {
  green: boolean;
  /** One line per gate, the shape a review and an implementer read a verdict from. */
  report: string;
  gates: Ran[];
};

/** The repository the run belongs to. A worktree's .git is a file naming the repository that owns it. */
function rootOf(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    const marker = path.join(dir, ".git");
    if (fs.existsSync(marker)) return repoOf(dir, marker);
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(cwd);
    dir = up;
  }
}

function repoOf(dir: string, marker: string): string {
  if (fs.statSync(marker).isDirectory()) return dir;
  const linked = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(marker, "utf8"))?.[1];
  if (linked === undefined) return dir;
  const resolved = path.resolve(dir, linked);
  const split = resolved.lastIndexOf(`${path.sep}.git${path.sep}`);
  return split === -1 ? dir : resolved.slice(0, split);
}

export default adapter({
  role: "gates",
  name: "file",
  description:
    "the quality gates a project lists in ~/.penguin/gates/<project>, run as written, each one scoped to the paths a change touches",
  build: (host) => {
    // Gates are machine-local config, kept out of the repository so a tool that
    // rewrites the root checkout (a mirror, a stash) never has to carry them.
    const file = path.join(host.home, "gates", path.basename(rootOf(host.cwd)));

    const listed = (): string | undefined =>
      fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;

    /**
     * Every path the change touches: what the diff since names, plus what the tree
     * holds uncommitted. Undefined when git cannot say, which runs every gate.
     */
    async function changedSince(
      since: string,
      cwd: string | undefined,
    ): Promise<string[] | undefined> {
      const diff = await host.exec(["git", "diff", "--name-only", since], { cwd });
      if (diff.code !== 0) return undefined;
      const files = new Set(diff.stdout.split("\n").filter((line) => line.trim() !== ""));
      const status = await host.exec(
        ["git", "status", "--porcelain", "-z", "--untracked-files=all"],
        { cwd },
      );
      if (status.code !== 0) return undefined;
      const entries = status.stdout.split("\0").filter((entry) => entry !== "");
      for (let at = 0; at < entries.length; at++) {
        const entry = entries[at] ?? "";
        const code = entry.slice(0, 2);
        files.add(entry.slice(3));
        // A rename or a copy prints where the path came from as the next entry, and that path changed too.
        if (code.startsWith("R") || code.startsWith("C")) {
          const from = entries[++at];
          if (from !== undefined) files.add(from);
        }
      }
      return [...files];
    }

    return {
      /** The gate file as a person wrote it, undefined when the project has none. */
      async read(): Promise<string | undefined> {
        return listed();
      },
      async write(text: string): Promise<void> {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
      },
      /**
       * Every gate the change reaches, run once, in order. `since` names the commit
       * the change starts from and keeps a scoped gate out of a run that never
       * touched its path. Without it every gate runs.
       */
      async run(options?: { cwd?: string; since?: string }): Promise<Result> {
        const changed =
          options?.since === undefined ? undefined : await changedSince(options.since, options.cwd);
        const ran: Ran[] = [];
        for (const gate of gatesFor(parseGates(listed() ?? ""), changed)) {
          const done = await host.shell(gate.command, { cwd: options?.cwd });
          ran.push({
            command: gate.command,
            code: done.code,
            output: tail(done.stdout + done.stderr),
          });
        }
        return {
          green: ran.every((gate) => gate.code === 0),
          report: reportOf(ran),
          gates: ran,
        };
      },
    };
  },
});
