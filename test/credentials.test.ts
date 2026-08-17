import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadAdapter } from "../src/adapters.ts";
import * as credentials from "../src/credentials.ts";
import type { CredentialRequest, Host } from "../src/types.ts";
import { attach } from "../src/viewer.ts";
import { type Event, type Sandbox, sandbox, terminal, waitFor } from "./helpers.ts";

const jiraFile = fileURLToPath(new URL("../examples/adapters/jira.ts", import.meta.url));

const TOKEN = "s3cret-jira-token";

function stubHost(credential: Host["credential"]): Host {
  return {
    cwd: process.cwd(),
    shell: async () => ({ code: 0, stdout: "", stderr: "" }),
    exec: async () => 0,
    wait: <T>(_label: string, body: () => Promise<T>) => body(),
    emit: () => {},
    credential,
  };
}

/** An adapter that needs a site and a token, the way the jira adapter does. */
function needsSource(refresh = false): string {
  return `import { adapter } from "penguin";

export default adapter({
  role: "tracker",
  name: "test",
  description: "an adapter that needs a credential",
  build: (host) => ({
    async whoami() {
      const creds = await host.credential({
        name: "tracker",
        label: "Tracker",
        url: "https://tracker.test/tokens",
        hint: "make a read token",
        refresh: ${refresh},
        fields: [
          { name: "site", label: "Your tracker site", env: "TRACKER_SITE" },
          { name: "token", label: "A tracker API token", env: "TRACKER_TOKEN", secret: true },
        ],
      });
      return { site: creds.site, token: creds.token };
    },
  }),
});
`;
}

const callWorkflow = `import { workflow } from "penguin";
import { z } from "zod";

export default workflow({
  description: "test",
  params: z.object({}),
  async run({ tracker }) {
    const who = await tracker.whoami();
    return \`\${who.site} \${who.token === ${JSON.stringify(TOKEN)} ? "matched" : "wrong"}\`;
  },
});
`;

function inbox(box: Sandbox, run: string): string {
  return fs.readFileSync(path.join(box.runDir(run), "inbox.jsonl"), "utf8");
}

function events(box: Sandbox, run: string): string {
  return fs.readFileSync(path.join(box.runDir(run), "events.jsonl"), "utf8");
}

function asked(box: Sandbox, run: string): Event[] {
  return box
    .events(run)
    .filter((event) => event["type"] === "credential" && event["phase"] === "asked");
}

function store(box: Sandbox, name: string): Record<string, string> {
  const file = path.join(box.home, "credentials", `${name}.json`);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
}

test("the store keeps one record per credential, readable by the user alone", (t) => {
  const box = sandbox(t);
  const prior = process.env["PENGUIN_HOME"];
  process.env["PENGUIN_HOME"] = box.home;
  t.after(() => {
    if (prior === undefined) delete process.env["PENGUIN_HOME"];
    else process.env["PENGUIN_HOME"] = prior;
  });

  assert.deepEqual(credentials.read("jira"), {});
  const where = credentials.save("jira", { site: "acme.atlassian.net", token: TOKEN });
  assert.deepEqual(credentials.read("jira"), { site: "acme.atlassian.net", token: TOKEN });
  assert.equal(where, credentials.where("jira"));

  const file = path.join(box.home, "credentials", "jira.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "only the user can read the file");
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

  credentials.save("jira", { token: "rotated" });
  assert.deepEqual(
    credentials.read("jira"),
    { site: "acme.atlassian.net", token: "rotated" },
    "a save keeps the fields it was not given",
  );

  credentials.forget("jira");
  assert.deepEqual(credentials.read("jira"), {});
  credentials.forget("jira");

  assert.throws(() => credentials.read("../escape"), /is not a credential name/);
});

test("invariant 12: a credential reaches the store, never the run's files", async (t) => {
  const box = sandbox(t);
  box.writeAdapter("tracker", needsSource());
  box.write("w.ts", callWorkflow);
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  assert.equal(box.lastState("w-1")?.["detail"], "Tracker needs a credential");
  const ask = asked(box, "w-1")[0];
  assert.equal(ask?.["url"], "https://tracker.test/tokens");
  assert.deepEqual(ask?.["fields"], [
    { name: "site", label: "Your tracker site", secret: false, env: "TRACKER_SITE" },
    { name: "token", label: "A tracker API token", secret: true, env: "TRACKER_TOKEN" },
  ]);

  const screen = terminal(t, box.home);
  const watching = attach("w-1");
  await waitFor(() => screen.text().includes("Your tracker site"));
  screen.input.write("acme.tracker.test\r");
  await waitFor(() => screen.text().includes("A tracker API token"));
  screen.input.write(`${TOKEN}\r`);
  const ended = await box.waitForEnd("w-1");
  const code = await watching;
  const shown = screen.stop();

  assert.equal(code, 0);
  assert.equal(ended["result"], "acme.tracker.test matched");
  assert.deepEqual(store(box, "tracker"), { site: "acme.tracker.test", token: TOKEN });

  assert.equal(events(box, "w-1").includes(TOKEN), false, "no secret in events.jsonl");
  assert.equal(inbox(box, "w-1").includes(TOKEN), false, "no secret in inbox.jsonl");
  assert.match(inbox(box, "w-1"), /"credential":"tracker"/);
  assert.equal(shown.includes(TOKEN), false, "no secret on the screen");
  assert.ok(shown.includes("*".repeat(TOKEN.length)), "the secret field echoes stars");
  assert.ok(shown.includes("acme.tracker.test"), "a field that is not secret shows");

  const ready = box.events("w-1").find((event) => event["phase"] === "ready");
  assert.equal(ready?.["where"], path.join(box.home, "credentials", "tracker.json"));
  assert.equal(asked(box, "w-1").length, 1, "one ask took one credential");
});

test("a credential the environment supplies is never asked for", async (t) => {
  const box = sandbox(t);
  box.writeAdapter("tracker", needsSource());
  box.write("w.ts", callWorkflow);

  const done = box.penguinWith({ TRACKER_SITE: "env.tracker.test", TRACKER_TOKEN: TOKEN }, "run", "./w.ts");

  assert.equal(done.code, 0, done.output);
  assert.equal(box.ended("w-1")?.["result"], "env.tracker.test matched");
  assert.equal(asked(box, "w-1").length, 0, "nothing was asked");
  assert.equal(events(box, "w-1").includes(TOKEN), false);
  assert.deepEqual(store(box, "tracker"), {}, "the environment is not written to the store");
  const ready = box.events("w-1").find((event) => event["phase"] === "ready");
  assert.equal(ready?.["where"], "the environment");
});

test("a stored credential runs without a question, and refresh asks again", async (t) => {
  const box = sandbox(t);
  box.writeAdapter("tracker", needsSource());
  box.write("w.ts", callWorkflow);
  fs.mkdirSync(path.join(box.home, "credentials"), { recursive: true });
  fs.writeFileSync(
    path.join(box.home, "credentials", "tracker.json"),
    JSON.stringify({ site: "kept.tracker.test", token: TOKEN }),
  );

  const done = box.penguin("run", "./w.ts");
  assert.equal(done.code, 0, done.output);
  assert.equal(box.ended("w-1")?.["result"], "kept.tracker.test matched");
  assert.equal(asked(box, "w-1").length, 0);

  box.writeAdapter("tracker", needsSource(true));
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-2", "blocked");

  assert.equal(asked(box, "w-2").length, 1, "refresh threw the stored record away");
  assert.deepEqual(store(box, "tracker"), {}, "the store is empty while penguin asks");
});

test("the entry prompt leaves the cursor where the user types", async (t) => {
  const box = sandbox(t);
  box.writeAdapter("tracker", needsSource());
  box.write("w.ts", callWorkflow);
  assert.equal(box.penguin("run", "./w.ts", "--background").code, 0);
  await box.waitForState("w-1", "blocked");

  const screen = terminal(t, box.home);
  const watching = attach("w-1");
  await waitFor(() => screen.text().includes("Your tracker site"));

  screen.input.write("ab");
  const parked = "\x1b[2A\x1b[5G";
  await waitFor(() => screen.text().endsWith(parked), 2000).catch(() => {
    assert.fail(`the cursor did not land after "> ab": ${JSON.stringify(screen.text().slice(-40))}`);
  });

  screen.input.write("c.tracker.test\r");
  await waitFor(() => screen.text().includes("A tracker API token"));
  screen.input.write(`${TOKEN}\r`);
  const ended = await box.waitForEnd("w-1");
  const code = await watching;
  screen.stop();

  assert.equal(code, 0);
  assert.equal(ended["result"], "abc.tracker.test matched");
});

test("without a terminal the ask names the link and the environment variables", async (t) => {
  const box = sandbox(t);
  box.writeAdapter("tracker", needsSource());
  box.write("w.ts", callWorkflow);
  const child = box.start("run", "./w.ts");
  let text = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });

  await waitFor(() => text.includes("credential:"));
  child.kill("SIGTERM");

  assert.match(text, /credential: Tracker needs site, token/);
  assert.match(text, /make one at https:\/\/tracker\.test\/tokens/);
  assert.match(text, /make a read token/);
  assert.match(text, /or set TRACKER_SITE, TRACKER_TOKEN in your environment/);
});

test("the jira adapter asks for the site, the email, and the token, with the token link", async () => {
  const definition = await loadAdapter(jiraFile);
  let request: CredentialRequest | undefined;
  const calls: { url: string; method: string; auth: string; body: unknown }[] = [];
  const host = stubHost((async (asking: CredentialRequest) => {
    request = asking;
    return { site: "acme", email: "me@acme.test", token: TOKEN };
  }) as Host["credential"]);

  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      auth: String((init?.headers as Record<string, string>)["authorization"]),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(
      JSON.stringify({
        key: "ABC-1",
        fields: {
          summary: "the summary",
          description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "why" }] }] },
          status: { name: "In Progress" },
          issuetype: { name: "Bug" },
          assignee: { displayName: "Ada" },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const api = definition.build(host) as {
      issue: {
        get(key: string): Promise<{ ok: boolean; issue: { url: string; status: string } | null }>;
        comment(key: string, body: string): Promise<{ ok: boolean }>;
      };
    };
    const got = await api.issue.get("ABC-1");
    await api.issue.comment("ABC-1", "one line\nsame paragraph\n\nnext paragraph");

    assert.equal(request?.name, "jira");
    assert.equal(request?.url, "https://id.atlassian.com/manage-profile/security/api-tokens");
    assert.deepEqual(
      request?.fields.map((field) => [field.name, field.env, field.secret === true]),
      [
        ["site", "JIRA_SITE", false],
        ["email", "JIRA_EMAIL", false],
        ["token", "JIRA_API_TOKEN", true],
      ],
      "only the token is a secret",
    );

    assert.equal(got.ok, true);
    assert.equal(got.issue?.status, "In Progress");
    assert.equal(got.issue?.url, "https://acme.atlassian.net/browse/ABC-1");
    assert.equal(
      calls[0]?.url,
      "https://acme.atlassian.net/rest/api/3/issue/ABC-1?fields=summary,description,status,issuetype,assignee",
    );
    assert.equal(
      calls[0]?.auth,
      `Basic ${Buffer.from(`me@acme.test:${TOKEN}`).toString("base64")}`,
      "basic auth over the email and the token",
    );
    assert.equal(calls[1]?.url, "https://acme.atlassian.net/rest/api/3/issue/ABC-1/comment");
    assert.deepEqual(calls[1]?.body, {
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "one line" },
              { type: "hardBreak" },
              { type: "text", text: "same paragraph" },
            ],
          },
          { type: "paragraph", content: [{ type: "text", text: "next paragraph" }] },
        ],
      },
    });
  } finally {
    globalThis.fetch = real;
  }
});

test("the jira adapter asks again once when the site rejects the token", async () => {
  const definition = await loadAdapter(jiraFile);
  const asks: boolean[] = [];
  const host = stubHost((async (asking: CredentialRequest) => {
    asks.push(asking.refresh === true);
    return { site: "acme", email: "me@acme.test", token: TOKEN };
  }) as Host["credential"]);

  const real = globalThis.fetch;
  let tries = 0;
  globalThis.fetch = (async () => {
    tries += 1;
    return new Response(JSON.stringify({ errorMessages: ["Client must be authenticated"] }), {
      status: 401,
      statusText: "Unauthorized",
    });
  }) as typeof fetch;

  try {
    const api = definition.build(host) as {
      issue: { get(key: string): Promise<{ ok: boolean; reason: string }> };
    };
    const got = await api.issue.get("ABC-1");

    assert.equal(got.ok, false);
    assert.match(got.reason, /401 Unauthorized: Client must be authenticated/);
    assert.equal(tries, 2, "one retry, not a loop");
    assert.deepEqual(asks, [false, true], "the second ask forgets the rejected token");
  } finally {
    globalThis.fetch = real;
  }
});
