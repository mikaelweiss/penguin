import type { AgentAdapter, AgentTurn, Host, ViewEvent } from "@mikaelweiss/penguin-engine";
import { loadAdapter } from "@mikaelweiss/penguin-engine/catalog";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

const claudeFile = fileURLToPath(
  new URL("../packages/engine/examples/adapters/claude.ts", import.meta.url),
);

type Run = { argv: string[]; cwd?: string; stdin?: string };

function claudeHost(
  catalogs: string[],
  lines: unknown[],
): { host: Host; runs: Run[]; events: ViewEvent[] } {
  const runs: Run[] = [];
  const events: ViewEvent[] = [];
  const host: Host = {
    cwd: "/repo",
    state: "/state/penguin",
    catalogs,
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    async exec(argv, options) {
      runs.push({ argv, cwd: options?.cwd, stdin: options?.stdin });
      for (const line of lines) options?.onOutput?.(`${JSON.stringify(line)}\n`, "stdout");
      return 0;
    },
    wait: (_label, body) => body(),
    emit: (event) => {
      events.push(event);
    },
    gate: (() => {
      throw new Error("the claude adapter asks no gate");
    }) as Host["gate"],
    credential: (() => {
      throw new Error("the claude adapter asks for no credential");
    }) as Host["credential"],
  };
  return { host, runs, events };
}

function turnOf(over: Partial<AgentTurn> = {}): AgentTurn {
  return { session: "s1", first: true, cwd: "/repo", prompt: "do it", options: {}, ...over };
}

const done = { type: "result", is_error: false, structured_output: { ok: true } };

test("a claude turn carries the permission mode, every catalog directory, and the pn list allowance", async () => {
  const definition = await loadAdapter(claudeFile);
  const { host, runs } = claudeHost(["/repo/.penguin", "/home/me/.penguin"], [done]);
  const api = definition.build(host) as AgentAdapter;

  const outcome = await api.turn(turnOf({ schema: { type: "object" } }));

  assert.deepEqual(outcome, { ok: true, value: { ok: true } });
  assert.deepEqual(runs[0]?.argv, [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    '{"type":"object"}',
    "--session-id",
    "s1",
    "--permission-mode",
    "acceptEdits",
    "--add-dir",
    "/repo/.penguin",
    "--add-dir",
    "/home/me/.penguin",
    "--allowedTools",
    "Bash(pn list:*)",
  ]);
  assert.equal(runs[0]?.cwd, "/repo");
  assert.equal(runs[0]?.stdin, "do it");
});

test("a later claude turn resumes the session and keeps the same access", async () => {
  const definition = await loadAdapter(claudeFile);
  const { host, runs } = claudeHost(["/home/me/.penguin"], [done]);
  const api = definition.build(host) as AgentAdapter;

  await api.turn(turnOf({ first: false, options: { permission: "plan" } }));

  assert.deepEqual(runs[0]?.argv, [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--resume",
    "s1",
    "--permission-mode",
    "plan",
    "--add-dir",
    "/home/me/.penguin",
    "--allowedTools",
    "Bash(pn list:*)",
  ]);
});
