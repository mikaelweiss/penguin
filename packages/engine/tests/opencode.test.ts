import { expect, test } from "bun:test";
import type { CommandResult, ExecOptions, Host } from "../src/core/adapter.ts";
import opencode from "../examples/adapters/opencode.ts";

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

type Call = { argv: string[]; options: ExecOptions | undefined };

function fakeHost(result: CommandResult, events: unknown[] = []): { host: Host; calls: Call[] } {
  const calls: Call[] = [];
  const host: Host = {
    cwd: "/",
    home: "/tmp",
    state: "/tmp",
    run: { id: "test", dir: "/tmp" },
    config: () => undefined,
    secret: async () => undefined,
    note: () => {},
    open: () => {},
    skill: () => {
      throw new Error("no skills installed");
    },
    spawn: () => {
      throw new Error("no spawn in this test");
    },
    shell: async () => OK,
    exec: async (argv, options) => {
      calls.push({ argv, options });
      for (const event of events) options?.onOutput?.(`${JSON.stringify(event)}\n`, "stdout");
      return result;
    },
  };
  return { host, calls };
}

/** The generic 500 opencode emits for a server defect, which names nothing about the cause. */
const GENERIC = {
  type: "error",
  sessionID: "s1",
  error: {
    name: "UnknownError",
    data: {
      message: "Unexpected server error. Check server logs for details.",
      ref: "err_4c0d37fd",
    },
  },
};

test("a generic server error keeps its name and ref, and gains the cause opencode logged", async () => {
  const log =
    "timestamp=2026-09-10T21:02:01.800Z level=ERROR run=8c281091 message=failed ref=err_4c0d37fd " +
    'error="ProviderModelNotFoundError: Model not found: zai-coding-plan/glm-5.3" cause="stack"';
  const { host } = fakeHost({ code: 0, stdout: "", stderr: log }, [GENERIC]);
  const agent = opencode.build(host);
  const session = await agent.open();
  const failure = await agent.turn(session, "go").value.catch((error: unknown) => error);
  expect(String(failure)).toContain("UnknownError: Unexpected server error");
  expect(String(failure)).toContain("(ref err_4c0d37fd)");
  expect(String(failure)).toContain(
    "ProviderModelNotFoundError: Model not found: zai-coding-plan/glm-5.3",
  );
});

test("opencode runs with its logs on stderr, where the cause of a generic 500 lives", async () => {
  const { host, calls } = fakeHost(OK);
  const agent = opencode.build(host);
  await agent.turn(await agent.open(), "go").value.catch(() => {});
  expect(calls[0]?.argv).toContain("--print-logs");
});
