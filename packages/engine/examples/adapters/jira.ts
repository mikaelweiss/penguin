import fs from "node:fs";
import path from "node:path";
import { adapter } from "penguin";

const TOKENS = "https://id.atlassian.com/manage-profile/security/api-tokens";
const FIELDS = ["summary", "description", "status", "issuetype", "assignee"];

/** Jira answers a wrong site, login, or token with one of these, and 404 hides a missing right. */
const HINTED = new Set([401, 403, 404]);

/** Only a definite refusal pauses for new credentials. 404 can also mean a missing issue. */
const REFUSING = new Set([401, 403]);

type Creds = { site: string; email: string; token: string };

type Issue = {
  key: string;
  summary: string;
  description: string;
  status: string;
  type: string;
  assignee: string;
  url: string;
};

type Comment = {
  author: string;
  at: string;
  body: string;
};

type Reply = { ok: boolean; status: number; body: unknown; reason: string; base: string };

export function siteUrl(site: string): string {
  const host = site.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `https://${host.includes(".") ? host : `${host}.atlassian.net`}`;
}

/** Jira sends rich text as an Atlassian document. A workflow wants the words. */
export function plain(node: unknown): string {
  if (typeof node === "string") return node;
  if (node === null || typeof node !== "object") return "";
  const one = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof one.text === "string") return one.text;
  const inside = (one.content ?? []).map(plain).join("");
  const block = one.type === "paragraph" || one.type === "heading" || one.type === "listItem";
  return block ? `${inside}\n` : inside;
}

/** Jira takes rich text as an Atlassian document. An agent writes plain markdown. */
export function document(body: string): Record<string, unknown> {
  const parts = body
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return {
    type: "doc",
    version: 1,
    content: (parts.length === 0 ? [""] : parts).map((part) => ({
      type: "paragraph",
      content: inline(part),
    })),
  };
}

function inline(part: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  for (const [index, line] of part.split("\n").entries()) {
    if (index > 0) nodes.push({ type: "hardBreak" });
    if (line !== "") nodes.push({ type: "text", text: line });
  }
  return nodes;
}

function named(value: unknown): string {
  const holder = value as { name?: unknown; displayName?: unknown } | null;
  const label = holder?.displayName ?? holder?.name;
  return typeof label === "string" ? label : "";
}

function issueOf(body: unknown, base: string): Issue {
  const one = (body ?? {}) as { key?: unknown; fields?: Record<string, unknown> };
  const fields = one.fields ?? {};
  const key = typeof one.key === "string" ? one.key : "";
  return {
    key,
    summary: plain(fields["summary"]).trim(),
    description: plain(fields["description"]).trim(),
    status: named(fields["status"]),
    type: named(fields["issuetype"]),
    assignee: named(fields["assignee"]),
    url: key === "" ? "" : `${base}/browse/${key}`,
  };
}

function commentsOf(body: unknown): Comment[] {
  const list = (body as { comments?: unknown[] } | null)?.comments ?? [];
  return list.map((one) => {
    const note = one as { author?: unknown; created?: unknown; body?: unknown };
    return {
      author: named(note.author),
      at: typeof note.created === "string" ? note.created : "",
      body: plain(note.body).trim(),
    };
  });
}

function transitionsOf(body: unknown): { id: string; name: string }[] {
  const list = (body as { transitions?: unknown[] } | null)?.transitions ?? [];
  return list.map((one) => {
    const step = one as { id?: unknown; name?: unknown };
    return { id: String(step.id ?? ""), name: typeof step.name === "string" ? step.name : "" };
  });
}

function detail(body: unknown, text: string): string {
  const failure = body as { errorMessages?: unknown; errors?: Record<string, unknown> } | null;
  const messages = Array.isArray(failure?.errorMessages) ? failure.errorMessages.map(String) : [];
  const fields = Object.entries(failure?.errors ?? {}).map(([field, why]) => `${field}: ${String(why)}`);
  const all = [...messages, ...fields];
  if (all.length > 0) return `: ${all.join("; ")}`;
  return text === "" ? "" : `: ${text.slice(0, 200)}`;
}

export default adapter({
  role: "jira",
  name: "cloud",
  description: "Jira Cloud issues over the REST API: read, search, create, comment, and transition",
  build: (host) => {
    const epoch = path.join(host.state, "auth", "jira");
    const refused = new Set<string>();
    let refusal: string | undefined;
    let waiting: Promise<void> | undefined;

    const keyOf = (held: Creds): string => JSON.stringify([held.site, held.email, held.token]);

    const whole = (held: Partial<Creds>): Creds | undefined =>
      held.site !== undefined && held.email !== undefined && held.token !== undefined
        ? { site: held.site, email: held.email, token: held.token }
        : undefined;

    /** The keychain item the penguin app saves, one JSON of site, email, and token. */
    async function stored(): Promise<Partial<Creds>> {
      const raw = await host.secret("jira");
      if (raw === undefined) return {};
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {};
      }
      const text = (value: unknown): string | undefined =>
        typeof value === "string" && value !== "" ? value : undefined;
      return { site: text(parsed["site"]), email: text(parsed["email"]), token: text(parsed["token"]) };
    }

    /** Environment first, then the keychain, then ~/.penguin/config. Refused tuples wait their turn out. */
    async function creds(): Promise<Creds | { reason: string }> {
      const saved = await stored();
      const layered = (env: string, kept: string | undefined, key: string): string | undefined => {
        const fromEnv = process.env[env];
        if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
        return kept ?? host.config(key);
      };
      const merged: Partial<Creds> = {
        site: layered("JIRA_SITE", saved.site, "jira-site"),
        email: layered("JIRA_EMAIL", saved.email, "jira-email"),
        token: layered("JIRA_API_TOKEN", saved.token, "jira-token"),
      };
      const config: Partial<Creds> = {
        site: host.config("jira-site"),
        email: host.config("jira-email"),
        token: host.config("jira-token"),
      };
      const candidates = [merged, saved, config]
        .map(whole)
        .filter((held): held is Creds => held !== undefined);
      for (const held of candidates) {
        if (!refused.has(keyOf(held))) return held;
      }
      if (candidates.length > 0) {
        return { reason: refusal ?? "Jira refused the credentials: enter new ones" };
      }
      return {
        reason:
          `Jira needs credentials: a site, an email, and an API token. ` +
          `Enter them in the penguin app, or set JIRA_SITE, JIRA_EMAIL, and JIRA_API_TOKEN. ` +
          `Make a token at ${TOKENS}.`,
      };
    }

    const epochValue = (): string => {
      try {
        return fs.readFileSync(epoch, "utf8");
      } catch {
        return "";
      }
    };

    /** Notes the pause once, then every caller waits for the app to save new credentials. */
    function authPause(reason: string): Promise<void> {
      if (waiting !== undefined) return waiting;
      const since = epochValue();
      host.note({ auth: { role: "jira", reason } });
      waiting = new Promise<void>((resolve) => {
        const check = (): void => {
          if (epochValue() === since) return;
          fs.unwatchFile(epoch, check);
          resolve();
        };
        fs.watchFile(epoch, { interval: 500 }, check);
        check();
      }).then(() => {
        // A save wipes the shelf, so re-entered credentials get one retry too.
        refused.clear();
        host.note({ auth: { role: "jira", resolved: true } });
        waiting = undefined;
      });
      return waiting;
    }

    /** A refusal shelves the tuple and tries the next. The pause comes when nothing is left. */
    async function call(method: string, route: string, body?: unknown): Promise<Reply> {
      for (;;) {
        const held = await creds();
        if ("reason" in held) {
          await authPause(held.reason);
          continue;
        }
        const reply = await request(held, method, route, body);
        if (REFUSING.has(reply.status)) {
          refused.add(keyOf(held));
          refusal = reply.reason;
          continue;
        }
        return reply;
      }
    }

    async function request(held: Creds, method: string, route: string, body?: unknown): Promise<Reply> {
      const base = siteUrl(held.site);
      const auth = Buffer.from(`${held.email}:${held.token}`).toString("base64");
      try {
        const response = await fetch(`${base}${route}`, {
          method,
          headers: {
            authorization: `Basic ${auth}`,
            accept: "application/json",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        let parsed: unknown = null;
        try {
          parsed = text === "" ? null : JSON.parse(text);
        } catch {
          parsed = null;
        }
        let reason = "";
        if (!response.ok) {
          reason = `${response.status} ${response.statusText}${detail(parsed, text)}`;
          if (HINTED.has(response.status)) {
            reason += `. Jira refused the credentials: check the site, the email, and the token.`;
          }
        }
        return { ok: response.ok, status: response.status, body: parsed, reason, base };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, status: 0, body: null, reason, base };
      }
    }

    return {
      issue: {
        async get(key: string): Promise<{ ok: boolean; issue: Issue | null; reason: string }> {
          const route = `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(",")}`;
          const reply = await call("GET", route);
          if (!reply.ok) return { ok: false, issue: null, reason: reply.reason };
          const found = issueOf(reply.body, reply.base);
          host.open(found.url);
          return { ok: true, issue: found, reason: "" };
        },

        async comments(
          key: string,
          options?: { max?: number },
        ): Promise<{ ok: boolean; comments: Comment[]; reason: string }> {
          const max = options?.max ?? 50;
          const route = `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=${max}&orderBy=created`;
          const reply = await call("GET", route);
          if (!reply.ok) return { ok: false, comments: [], reason: reply.reason };
          return { ok: true, comments: commentsOf(reply.body), reason: "" };
        },

        async search(
          jql: string,
          options?: { max?: number },
        ): Promise<{ ok: boolean; issues: Issue[]; reason: string }> {
          const reply = await call("POST", "/rest/api/3/search/jql", {
            jql,
            fields: FIELDS,
            maxResults: options?.max ?? 25,
          });
          if (!reply.ok) return { ok: false, issues: [], reason: reply.reason };
          const found = (reply.body as { issues?: unknown[] } | null)?.issues ?? [];
          return { ok: true, issues: found.map((one) => issueOf(one, reply.base)), reason: "" };
        },

        async create(fields: {
          project: string;
          type: string;
          summary: string;
          description?: string;
        }): Promise<{ ok: boolean; key: string; url: string; reason: string }> {
          const description = fields.description ?? "";
          const reply = await call("POST", "/rest/api/3/issue", {
            fields: {
              project: { key: fields.project },
              issuetype: { name: fields.type },
              summary: fields.summary,
              ...(description === "" ? {} : { description: document(description) }),
            },
          });
          if (!reply.ok) return { ok: false, key: "", url: "", reason: reply.reason };
          const key = String((reply.body as { key?: unknown } | null)?.key ?? "");
          const url = `${reply.base}/browse/${key}`;
          host.open(url);
          return { ok: true, key, url, reason: "" };
        },

        async comment(key: string, body: string): Promise<{ ok: boolean; reason: string }> {
          const route = `/rest/api/3/issue/${encodeURIComponent(key)}/comment`;
          const reply = await call("POST", route, { body: document(body) });
          return { ok: reply.ok, reason: reply.reason };
        },

        async transitions(key: string): Promise<{ ok: boolean; names: string[]; reason: string }> {
          const route = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
          const reply = await call("GET", route);
          if (!reply.ok) return { ok: false, names: [], reason: reply.reason };
          return { ok: true, names: transitionsOf(reply.body).map((step) => step.name), reason: "" };
        },

        async transition(key: string, to: string): Promise<{ ok: boolean; reason: string }> {
          const route = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
          const offered = await call("GET", route);
          if (!offered.ok) return { ok: false, reason: offered.reason };
          const steps = transitionsOf(offered.body);
          const found = steps.find((step) => step.name.toLowerCase() === to.toLowerCase());
          if (found === undefined) {
            const names = steps.map((step) => step.name).join(", ");
            return { ok: false, reason: `${key} has no transition named ${to}. It offers ${names}` };
          }
          const done = await call("POST", route, { transition: { id: found.id } });
          return { ok: done.ok, reason: done.reason };
        },
      },
    };
  },
});
