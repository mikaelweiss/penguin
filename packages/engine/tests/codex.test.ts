import { expect, test } from "bun:test";
import type { CommandResult, ExecOptions, Host } from "../src/core/adapter.ts";
import definition from "../examples/adapters/codex.ts";

type Call = { argv: string[]; options: ExecOptions | undefined };

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

function fakeHost(): { host: Host; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    host: {
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
        return OK;
      },
    },
  };
}

test("maps neutral model choices to codex models", async () => {
  for (const [model, expected] of [
    ["best", "gpt-5.6-sol"],
    ["big", "gpt-5.6-sol"],
    ["small", "gpt-5.6-terra"],
  ]) {
    const { host, calls } = fakeHost();
    const agent = definition.build(host);
    const session = await agent.open({ model });
    await agent.turn(session, "go").value;
    expect(calls[0]?.argv).toContain(`model="${expected}"`);
  }
});
