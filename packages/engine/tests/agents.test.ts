import { expect, test } from "bun:test";
import { routeAgents } from "../src/agents.ts";
import type { AdapterFound } from "../src/catalog/adapters.ts";
import type { Host } from "../src/core/adapter.ts";

type Log = string[];

function fakeHost(notes: Record<string, unknown>[]): Host {
  return {
    cwd: "/",
    home: "/tmp",
    state: "/tmp",
    run: { id: "test", dir: "/tmp" },
    config: () => undefined,
    secret: async () => undefined,
    note: (entry) => {
      notes.push(entry);
    },
    open: () => {},
    skill: () => {
      throw new Error("no skills installed");
    },
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    spawn: () => {
      throw new Error("no spawn in this test");
    },
  };
}

type Fake = {
  entry: AdapterFound;
  built: () => number;
};

/** One agent adapter that writes what it was asked to do into the shared log. */
function fake(name: string, log: Log, options?: { check?: string[]; broken?: boolean }): Fake {
  let built = 0;
  let opened = 0;
  const entry: AdapterFound = {
    role: "agent",
    name,
    description: `the ${name} agent`,
    scope: "project",
    file: `/adapters/${name}.ts`,
    definition: {
      role: "agent",
      name,
      description: `the ${name} agent`,
      ...(options?.check === undefined ? {} : { check: async () => options.check ?? [] }),
      build: () => {
        built += 1;
        if (options?.broken === true) throw new Error(`${name} will not build`);
        return {
          open: async (settings?: Record<string, unknown>) => {
            log.push(`${name}.open ${JSON.stringify(settings ?? null)}`);
            opened += 1;
            return `${name}-${opened}`;
          },
          turn: (session: string, ask: unknown) => {
            log.push(`${name}.turn ${session} ${String(ask)}`);
            return { by: name };
          },
          stop: async (session: string) => {
            log.push(`${name}.stop ${session}`);
          },
        };
      },
    },
  };
  return { entry, built: () => built };
}

test("a session names its adapter, and its turns and stop reach that adapter", async () => {
  const log: Log = [];
  const one = fake("one", log);
  const two = fake("two", log);
  const agent = routeAgents(fakeHost([]), [one.entry, two.entry], one.entry);

  const named = await agent.open({ adapter: "two", model: "normal" });
  const plain = await agent.open({ model: "small" });
  agent.turn(named, "go");
  agent.turn(plain, "go");
  await agent.stop(named);
  await agent.stop(plain);

  expect(log).toEqual([
    'two.open {"model":"normal"}',
    'one.open {"model":"small"}',
    "two.turn two-1 go",
    "one.turn one-1 go",
    "two.stop two-1",
    "one.stop one-1",
  ]);
});

test("naming the configured adapter routes to it without a second build", async () => {
  const log: Log = [];
  const one = fake("one", log);
  const agent = routeAgents(fakeHost([]), [one.entry], one.entry);

  await agent.open({ adapter: "one" });

  expect(log).toEqual(["one.open {}"]);
  expect(one.built()).toBe(1);
});

test("an adapter nobody installed falls back to the configured one and says so", async () => {
  const log: Log = [];
  const notes: Record<string, unknown>[] = [];
  const one = fake("one", log);
  const agent = routeAgents(fakeHost(notes), [one.entry], one.entry);

  const session = await agent.open({ adapter: "cursor", model: "normal" });
  agent.turn(session, "go");

  expect(log).toEqual(['one.open {"model":"normal"}', "one.turn one-1 go"]);
  expect(notes).toEqual([
    {
      fallback: {
        role: "agent",
        wanted: "cursor",
        used: "one",
        reason: "no agent adapter named cursor is installed",
      },
    },
  ]);
});

test("an adapter whose check objects falls back, and the run is told once", async () => {
  const log: Log = [];
  const notes: Record<string, unknown>[] = [];
  const one = fake("one", log);
  const two = fake("two", log, { check: ["cursor-agent is not installed or not on PATH."] });
  const agent = routeAgents(fakeHost(notes), [one.entry, two.entry], one.entry);

  await agent.open({ adapter: "two" });
  await agent.open({ adapter: "two" });

  expect(log).toEqual(["one.open {}", "one.open {}"]);
  expect(two.built()).toBe(0);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toEqual({
    fallback: {
      role: "agent",
      wanted: "two",
      used: "one",
      reason: "cursor-agent is not installed or not on PATH.",
    },
  });
});

test("an adapter that will not build falls back rather than ending the run", async () => {
  const log: Log = [];
  const notes: Record<string, unknown>[] = [];
  const one = fake("one", log);
  const two = fake("two", log, { broken: true });
  const agent = routeAgents(fakeHost(notes), [one.entry, two.entry], one.entry);

  const session = await agent.open({ adapter: "two" });

  expect(session).toBe("one-1");
  expect((notes[0]?.["fallback"] as Record<string, unknown>)["reason"]).toContain(
    "two will not build",
  );
});

test("a check that throws counts as a problem instead of failing the open", async () => {
  const log: Log = [];
  const notes: Record<string, unknown>[] = [];
  const one = fake("one", log);
  const two = fake("two", log);
  two.entry.definition.check = () => Promise.reject(new Error("the keychain is locked"));
  const agent = routeAgents(fakeHost(notes), [one.entry, two.entry], one.entry);

  expect(await agent.open({ adapter: "two" })).toBe("one-1");
  expect((notes[0]?.["fallback"] as Record<string, unknown>)["reason"]).toBe(
    "the keychain is locked",
  );
});

test("a session id the router never handed out goes to the configured adapter", async () => {
  const log: Log = [];
  const one = fake("one", log);
  const two = fake("two", log);
  const agent = routeAgents(fakeHost([]), [one.entry, two.entry], one.entry);

  agent.turn("replayed-from-an-older-run", "go");

  expect(log).toEqual(["one.turn replayed-from-an-older-run go"]);
});

test("only the configured adapter is built until a workflow names another", async () => {
  const log: Log = [];
  const one = fake("one", log);
  const two = fake("two", log);
  const agent = routeAgents(fakeHost([]), [one.entry, two.entry], one.entry);

  expect(one.built()).toBe(1);
  expect(two.built()).toBe(0);

  await agent.open({ adapter: "two" });
  await agent.open({ adapter: "two" });

  expect(two.built()).toBe(1);
});
