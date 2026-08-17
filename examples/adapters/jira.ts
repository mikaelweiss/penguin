import { adapter } from "penguin";

const TOKENS = "https://id.atlassian.com/manage-profile/security/api-tokens";
const FIELDS = ["summary", "description", "status", "issuetype", "assignee"];

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
    let held: Creds | undefined;

    async function creds(refresh: boolean): Promise<Creds> {
      if (refresh) held = undefined;
      held ??= await host.credential({
        name: "jira",
        label: "Jira",
        url: TOKENS,
        hint: "the token is a password: penguin sends it to your site over https and nowhere else",
        refresh,
        fields: [
          { name: "site", label: "Your Jira site, like acme.atlassian.net", env: "JIRA_SITE" },
          { name: "email", label: "The email you sign in to Atlassian with", env: "JIRA_EMAIL" },
          {
            name: "token",
            label: "An API token from the link above",
            env: "JIRA_API_TOKEN",
            secret: true,
          },
        ],
      });
      return held;
    }

    async function once(method: string, route: string, creds: Creds, body?: unknown): Promise<Reply> {
      const base = siteUrl(creds.site);
      const auth = Buffer.from(`${creds.email}:${creds.token}`).toString("base64");
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
        return {
          ok: response.ok,
          status: response.status,
          body: parsed,
          reason: response.ok ? "" : `${response.status} ${response.statusText}${detail(parsed, text)}`,
          base,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, status: 0, body: null, reason, base };
      }
    }

    /** A rejected token is asked for again, once. Everything else is the caller's news. */
    async function call(method: string, route: string, body?: unknown): Promise<Reply> {
      const first = await once(method, route, await creds(false), body);
      if (first.status !== 401) return first;
      return once(method, route, await creds(true), body);
    }

    return {
      issue: {
        async get(key: string): Promise<{ ok: boolean; issue: Issue | null; reason: string }> {
          const route = `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${FIELDS.join(",")}`;
          const reply = await call("GET", route);
          if (!reply.ok) return { ok: false, issue: null, reason: reply.reason };
          return { ok: true, issue: issueOf(reply.body, reply.base), reason: "" };
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
          return { ok: true, key, url: `${reply.base}/browse/${key}`, reason: "" };
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
