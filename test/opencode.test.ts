import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAdapter, type AgentAdapter, type AgentTurn, type ExecOptions, type Host, type ViewEvent } from "@mikaelweiss/penguin-engine";

const file = fileURLToPath(new URL("../packages/engine/examples/adapters/opencode.ts", import.meta.url));

type Played = { code?: number; stderr?: string };

function turnOf(over: Partial<AgentTurn> = {}): AgentTurn {
  return { session: "handle-1", first: true, cwd: "/project", prompt: "do it", options: {}, ...over };
}

const stepStart = (id: string): unknown => ({
  type: "step_start",
  sessionID: id,
  part: { type: "step-start" },
});

const says = (id: string, text: string): unknown => ({
  type: "text",
  sessionID: id,
  part: { type: "text", text },
});

function harness(lines: unknown[], played: Played = {}) {
  const argvs: string[][] = [];
  const stdins: (string | undefined)[] = [];
  const events: ViewEvent[] = [];
  const host = {
    cwd: "/project",
    shell: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    exec(argv: string[], options?: ExecOptions): Promise<number> {
      argvs.push(argv);
      stdins.push(options?.stdin);
      for (const line of lines) options?.onOutput?.(`${JSON.stringify(line)}\n`, "stdout");
      if (played.stderr !== undefined) options?.onOutput?.(played.stderr, "stderr");
      return Promise.resolve(played.code ?? 0);
    },
    wait: <T>(_label: string, body: () => Promise<T>) => body(),
    emit: (event: ViewEvent) => void events.push(event),
    credential: () => Promise.resolve({}),
  } as unknown as Host;
  return { host, argvs, stdins, events };
}

async function agentOn(host: Host): Promise<AgentAdapter> {
  const definition = await loadAdapter(file);
  return definition.build(host) as AgentAdapter;
}

async function once(lines: unknown[], over: Partial<AgentTurn> = {}, played: Played = {}) {
  const box = harness(lines, played);
  const agent = await agentOn(box.host);
  const result = await agent.turn(turnOf(over));
  return { result, ...box };
}

test("the first turn opens a session and a later turn resumes the id opencode gave", async () => {
  const box = harness([stepStart("ses_abc"), says("ses_abc", "hi")]);
  const agent = await agentOn(box.host);

  await agent.turn(turnOf());
  await agent.turn(turnOf({ first: false, prompt: "again" }));

  assert.deepEqual(box.argvs[0], ["opencode", "run", "--format", "json"]);
  assert.deepEqual(box.argvs[1], ["opencode", "run", "--format", "json", "--session", "ses_abc"]);
  assert.deepEqual(box.stdins, ["do it", "again"]);
});

test("the prompt goes down stdin, never into the arguments", async () => {
  const skill = "---\nname: penguin-implement\n---\n\nBuild the change.";

  const { argvs, stdins } = await once([says("ses_1", "ok")], { prompt: skill });

  assert.equal(stdins[0], skill);
  assert.deepEqual(
    argvs[0]?.filter((one) => one.startsWith("-")),
    ["--format"],
  );
});

test("a retry before any session opened starts one instead of failing", async () => {
  const { result, argvs } = await once([says("ses_1", "ok")], { first: false });

  assert.deepEqual(argvs[0], ["opencode", "run", "--format", "json"]);
  assert.deepEqual(result, { ok: true, value: null });
});

test("opencode events become penguin agent events", async () => {
  const { events } = await once([
    stepStart("ses_1"),
    { type: "reasoning", sessionID: "ses_1", part: { type: "reasoning", text: "weighing it" } },
    {
      type: "tool_use",
      sessionID: "ses_1",
      part: {
        type: "tool",
        tool: "bash",
        state: { status: "completed", input: { command: "ls  -la\n" } },
      },
    },
    says("ses_1", "done"),
  ]);

  assert.deepEqual(events, [
    { type: "agent", session: "handle-1", kind: "thinking", text: "weighing it" },
    { type: "agent", session: "handle-1", kind: "tool", text: "bash", detail: "ls -la" },
    { type: "agent", session: "handle-1", kind: "text", text: "done" },
  ]);
});

test("a schema asks for JSON in the prompt and reads the object back", async () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } } };

  const fencedRun = await once(
    [says("ses_1", 'here it is\n```json\n{"ok": true}\n```\n')],
    { schema },
  );
  const bareRun = await once([says("ses_1", 'the answer is {"ok": false}')], { schema });

  assert.equal(fencedRun.stdins[0]?.includes(JSON.stringify(schema)), true);
  assert.deepEqual(fencedRun.result, { ok: true, value: { ok: true } });
  assert.deepEqual(bareRun.result, { ok: true, value: { ok: false } });
});

test("a trailing block that is not JSON falls back to the block that is", async () => {
  const reply = 'here it is\n```json\n{"ok": true}\n```\n\nthen run\n\n```\npn run x\n```\n';

  const { result } = await once([says("ses_1", reply)], { schema: { type: "object" } });

  assert.deepEqual(result, { ok: true, value: { ok: true } });
});

test("a schema with no JSON in the reply fails the turn", async () => {
  const { result } = await once([says("ses_1", "I would rather not")], {
    schema: { type: "object" },
  });

  assert.deepEqual(result, { ok: false, error: "opencode returned no JSON result" });
});

test("a turn with no schema asks for nothing extra and returns null", async () => {
  const { result, stdins } = await once([says("ses_1", "done")]);

  assert.equal(stdins[0], "do it");
  assert.deepEqual(result, { ok: true, value: null });
});

test("an error event beats the exit code it comes with", async () => {
  const line = {
    type: "error",
    sessionID: "ses_1",
    error: { name: "AuthError", data: { message: "no key" } },
  };

  const { result } = await once([line], {}, { code: 1 });

  assert.deepEqual(result, { ok: false, error: "no key" });
});

test("a non-zero exit reports the last stderr line", async () => {
  const { result } = await once([], {}, { code: 2, stderr: "warming up\nopencode: no such model\n" });

  assert.deepEqual(result, {
    ok: false,
    error: "opencode exited with code 2: opencode: no such model",
  });
});

test("the model and agent options reach the command line", async () => {
  const { argvs } = await once([says("ses_1", "ok")], {
    options: { model: "anthropic/claude-sonnet-4", agent: "build" },
  });

  assert.deepEqual(argvs[0], [
    "opencode",
    "run",
    "--format",
    "json",
    "--model",
    "anthropic/claude-sonnet-4",
    "--agent",
    "build",
  ]);
});
