import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Host } from "../src/core/adapter.ts";
import { Fault } from "../src/core/errors.ts";
import definition from "../examples/adapters/jira.ts";

type Note = Record<string, unknown>;

type Fake = {
  host: Host;
  notes: Note[];
  opened: string[];
  save(creds: { site: string; email: string; token: string }): void;
  state: string;
};

function fakeHost(): Fake {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "penguin-jira-"));
  temps.push(state);
  const notes: Note[] = [];
  const opened: string[] = [];
  let secret: string | undefined;
  const host: Host = {
    cwd: "/",
    home: "/tmp",
    state,
    run: { id: "test", dir: state },
    config: () => undefined,
    secret: async () => secret,
    note: (entry) => notes.push(entry),
    open: (url) => opened.push(url),
    skill: () => {
      throw new Error("no skills installed");
    },
    spawn: () => {
      throw new Error("no spawn in this test");
    },
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };
  const save = (creds: { site: string; email: string; token: string }): void => {
    const savedAt = `${Date.now()}-${Math.random()}`;
    secret = JSON.stringify({ ...creds, savedAt });
    fs.mkdirSync(path.join(state, "auth"), { recursive: true });
    fs.writeFileSync(path.join(state, "auth", "jira"), savedAt);
  };
  return { host, notes, opened, save, state };
}

type Sent = { url: string; token: string };

function fakeFetch(handler: (sent: Sent, count: number) => Response): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const basic = headers["authorization"]?.replace(/^Basic /, "") ?? "";
    const token = Buffer.from(basic, "base64").toString().split(":")[1] ?? "";
    const one = { url: String(input), token };
    sent.push(one);
    return handler(one, sent.length);
  }) as typeof fetch;
  return sent;
}

function issueReply(): Response {
  return Response.json({ key: "PENG-1", fields: { summary: "hi" } });
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition never held");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const CREDS = { site: "acme", email: "me@acme.com", token: "good" };
const ENV = ["JIRA_SITE", "JIRA_EMAIL", "JIRA_API_TOKEN"];

let temps: string[] = [];
const realFetch = globalThis.fetch;
const heldEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of ENV) {
    heldEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [name, value] of heldEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
  temps = [];
});

test("missing credentials pause the call until the app saves them", async () => {
  const { host, notes, save } = fakeHost();
  fakeFetch(() => issueReply());
  const jira = definition.build(host);

  const reading = jira.issue.get("PENG-1");
  await until(() => notes.length === 1);
  expect(notes[0]?.["auth"]).toMatchObject({ role: "jira" });
  expect(String((notes[0]?.["auth"] as Note)["reason"])).toContain("Jira needs credentials");

  save(CREDS);
  const found = await reading;
  expect(found.key).toBe("PENG-1");
  expect((notes[1]?.["auth"] as Note)["resolved"]).toBe(true);
});

test("a refusal shelves the tuple and retries only with new credentials", async () => {
  const { host, notes, save } = fakeHost();
  save({ ...CREDS, token: "stale" });
  const sent = fakeFetch((one) =>
    one.token === "stale" ? Response.json({}, { status: 401 }) : issueReply(),
  );
  const jira = definition.build(host);

  const reading = jira.issue.get("PENG-1");
  await until(() => notes.length === 1);
  expect(String((notes[0]?.["auth"] as Note)["reason"])).toContain("401");

  save(CREDS);
  const found = await reading;
  expect(found.key).toBe("PENG-1");
  expect(sent.map((one) => one.token)).toEqual(["stale", "good"]);
});

test("refused environment credentials fall back to saved ones without pausing", async () => {
  const { host, notes, save } = fakeHost();
  process.env["JIRA_SITE"] = "acme";
  process.env["JIRA_EMAIL"] = "me@acme.com";
  process.env["JIRA_API_TOKEN"] = "stale";
  save(CREDS);
  const sent = fakeFetch((one) =>
    one.token === "stale" ? Response.json({}, { status: 401 }) : issueReply(),
  );
  const jira = definition.build(host);

  const found = await jira.issue.get("PENG-1");
  expect(found.key).toBe("PENG-1");
  expect(sent.map((one) => one.token)).toEqual(["stale", "good"]);
  expect(notes).toHaveLength(0);
});

test("a 404 returns an error without pausing", async () => {
  const { host, notes, save } = fakeHost();
  save(CREDS);
  fakeFetch(() => Response.json({}, { status: 404 }));
  const jira = definition.build(host);

  const failing = jira.issue.get("PENG-404");
  await expect(failing).rejects.toThrow(Fault);
  await expect(failing).rejects.toThrow("404");
  expect(notes).toHaveLength(0);
});

test("concurrent calls share one pause and one note pair", async () => {
  const { host, notes, save } = fakeHost();
  fakeFetch(() => issueReply());
  const jira = definition.build(host);

  const readings = [jira.issue.get("PENG-1"), jira.issue.get("PENG-2")];
  await until(() => notes.length === 1);

  save(CREDS);
  const found = await Promise.all(readings);
  expect(found.every((one) => one.key === "PENG-1")).toBe(true);
  expect(notes).toHaveLength(2);
});

test("reading a ticket puts it in front of the person watching", async () => {
  const { host, opened, save } = fakeHost();
  save(CREDS);
  fakeFetch(() => issueReply());
  const jira = definition.build(host);

  await jira.issue.get("PENG-1");
  expect(opened).toEqual(["https://acme.atlassian.net/browse/PENG-1"]);
});
