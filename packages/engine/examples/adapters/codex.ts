import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapter, type Action, type ActionKind } from "penguin";
import { clip, flatten, said, sessions, type Attempt, type Chunk, type Invocation } from "../helpers/turns.ts";

type OpenOptions = {
  cwd?: string;
  model?: string;
  sandbox?: string;
};

type Item = {
  id?: string;
  type?: string;
  status?: string;
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  changes?: { path?: string }[];
  server?: string;
  tool?: string;
  arguments?: unknown;
  query?: string;
  prompt?: string;
  receiver_thread_ids?: string[];
};

type StreamLine = {
  type?: string;
  thread_id?: string;
  item?: Item;
  error?: { message?: string };
  message?: string;
};

const TOOLS: Record<string, string> = {
  command_execution: "shell",
  file_change: "edit",
  web_search: "search",
};

const KINDS: Record<string, ActionKind> = {
  command_execution: "run",
  file_change: "edit",
  web_search: "fetch",
  collab_tool_call: "agent",
};

function toolName(item: Item): string | undefined {
  if (item.type === "mcp_tool_call") return `${item.server ?? "mcp"}.${item.tool ?? "call"}`;
  if (item.type === "collab_tool_call") return `collab.${item.tool ?? "call"}`;
  return TOOLS[item.type ?? ""];
}

function act(item: Item, name: string, id: string, status: Action["status"]): Action {
  const kind = KINDS[item.type ?? ""];
  const acted = target(item);
  const output = said(item.aggregated_output) ? clip(item.aggregated_output.trim()) : undefined;
  return {
    id,
    name,
    status,
    ...(kind === undefined ? {} : { kind }),
    ...(acted === undefined ? {} : { target: acted }),
    ...(status === "running" || output === undefined ? {} : { output }),
  };
}

/** The one value that says what a tool call acts on. Only this adapter knows codex item shapes. */
function target(item: Item): string | undefined {
  if (item.type === "command_execution") return blank(item.command);
  if (item.type === "file_change") {
    return blank((item.changes ?? []).map((change) => change.path).filter(said).join(", "));
  }
  if (item.type === "mcp_tool_call") {
    return blank(typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments));
  }
  if (item.type === "web_search") return blank(item.query);
  if (item.type === "collab_tool_call") {
    return blank(item.prompt ?? (item.receiver_thread_ids ?? []).join(", "));
  }
  return undefined;
}

function blank(text: string | undefined): string | undefined {
  const one = flatten(text ?? "");
  return one === "" ? undefined : one;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const BRANCHES = ["anyOf", "oneOf", "allOf", "prefixItems"];
const NAMED = ["$defs", "definitions"];

function listed(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

/** codex wants a strict schema: every property required, so an optional property becomes nullable. */
function strict(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  const properties = schema["properties"];
  if (isObject(properties)) {
    const required = new Set(listed(schema["required"]));
    const rewritten: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(properties)) {
      const child = isObject(entry) ? strict(entry) : entry;
      rewritten[name] = required.has(name) ? child : nullable(child);
    }
    out["properties"] = rewritten;
    out["required"] = Object.keys(properties);
    out["additionalProperties"] = false;
  }
  const items = schema["items"];
  if (isObject(items)) out["items"] = strict(items);
  for (const key of BRANCHES) {
    const list = schema[key];
    if (Array.isArray(list)) out[key] = list.map((entry) => (isObject(entry) ? strict(entry) : entry));
  }
  for (const key of NAMED) {
    const named = schema[key];
    if (isObject(named)) {
      out[key] = Object.fromEntries(
        Object.entries(named).map(([name, entry]) => [name, isObject(entry) ? strict(entry) : entry]),
      );
    }
  }
  return out;
}

function nullable(entry: unknown): unknown {
  if (!isObject(entry)) return entry;
  const type = entry["type"];
  if (typeof type !== "string") return { anyOf: [entry, { type: "null" }] };
  const out: Record<string, unknown> = { ...entry, type: [type, "null"] };
  const choices = entry["enum"];
  if (Array.isArray(choices)) out["enum"] = [...choices, null];
  if ("const" in entry) {
    delete out["const"];
    out["enum"] = [entry["const"], null];
  }
  return out;
}

/** The other half of the strict rewrite: a null under a key the schema left optional means absent. */
function clean(value: unknown, schema: Record<string, unknown>, root: Record<string, unknown>): unknown {
  const target = pointed(schema, root);
  if (Array.isArray(value)) {
    const prefix = Array.isArray(target["prefixItems"]) ? (target["prefixItems"] as unknown[]) : [];
    const items = target["items"];
    return value.map((entry, index) => {
      const child = prefix[index] ?? items;
      return isObject(child) ? clean(entry, child, root) : entry;
    });
  }
  const properties = target["properties"];
  if (!isObject(value) || !isObject(properties)) return value;
  const required = new Set(listed(target["required"]));
  const out: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (entry === null && !required.has(name)) continue;
    const child = properties[name];
    out[name] = isObject(child) ? clean(entry, child, root) : entry;
  }
  return out;
}

function pointed(schema: Record<string, unknown>, root: Record<string, unknown>): Record<string, unknown> {
  const ref = schema["$ref"];
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  let found: unknown = root;
  for (const step of ref.slice(2).split("/")) {
    if (!isObject(found)) return schema;
    found = found[step];
  }
  return isObject(found) ? found : schema;
}

function unfenced(text: string): string {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return fence?.[1] ?? text;
}

function structured(text: string): unknown {
  const direct = readJson(text);
  return direct === undefined ? readJson(unfenced(text)) : direct;
}

export default adapter({
  role: "agent",
  name: "codex",
  description:
    "runs prompts on the codex CLI. A session is one conversation: the first turn starts a codex thread, later turns resume it.",
  build: (host) => {
    const threads = new Map<string, string>();

    async function runOnce(
      invocation: Invocation<OpenOptions>,
      emit: (chunk: Chunk) => void,
    ): Promise<Attempt> {
      const { session, options, prompt, schema, signal } = invocation;
      const thread = threads.get(session);
      const argv = ["codex", "exec"];
      if (thread !== undefined) argv.push("resume", thread);
      argv.push("--json", "--skip-git-repo-check");
      if (options.model !== undefined) argv.push("-c", `model="${options.model}"`);
      // A run has no one to ask, and workspace-write blocks .git writes and the network.
      argv.push("-c", `sandbox_mode="${options.sandbox ?? "danger-full-access"}"`);
      const dir =
        schema === undefined ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "penguin-codex-"));

      try {
        if (schema !== undefined && dir !== undefined) {
          const file = path.join(dir, "schema.json");
          fs.writeFileSync(file, JSON.stringify(strict(schema)));
          argv.push("--output-schema", file);
        }
        argv.push("-");

        let buffer = "";
        let message: string | undefined;
        let failed: string | undefined;
        const handle = (line: string): void => {
          const parsed = readJson(line);
          if (!isObject(parsed)) return;
          const event = parsed as StreamLine;
          if (said(event.thread_id)) threads.set(session, event.thread_id);
          if (event.type === "turn.failed") {
            failed = event.error?.message ?? "codex reported a failed turn";
          }
          if (event.type === "error") failed = event.message ?? "codex reported an error";
          const item = event.item;
          if (item === undefined) return;
          if (event.type === "item.completed" && said(item.text)) {
            if (item.type === "agent_message") {
              message = item.text;
              emit({ kind: "text", text: item.text });
            }
            if (item.type === "reasoning") emit({ kind: "thinking", text: item.text });
          }
          if (event.type === "item.completed" && item.type === "error" && said(item.message)) {
            emit({ kind: "text", text: item.message });
          }
          const name = toolName(item);
          if (name === undefined) return;
          if (event.type === "item.started" && said(item.id)) {
            emit({ kind: "tool", call: act(item, name, item.id, "running") });
          }
          if (event.type === "item.completed") {
            const broke =
              item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
            const id = said(item.id) ? item.id : crypto.randomUUID();
            emit({ kind: "tool", call: act(item, name, id, broke ? "failed" : "done") });
          }
        };

        const done = await host.exec(argv, {
          cwd: path.resolve(host.cwd, options.cwd ?? "."),
          stdin: prompt,
          signal,
          onOutput: (chunk, stream) => {
            if (stream !== "stdout") return;
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) handle(line);
          },
        });
        if (buffer.trim() !== "") handle(buffer);

        if (done.code !== 0) {
          const tail = done.stderr.trim().split("\n").at(-1) ?? "";
          return {
            ok: false,
            error:
              tail === ""
                ? `codex exited with code ${done.code}`
                : `codex exited with code ${done.code}: ${tail}`,
          };
        }
        if (failed !== undefined) return { ok: false, error: failed };
        if (schema === undefined) return { ok: true, value: null };
        const value = message === undefined ? undefined : structured(message);
        if (value === undefined) return { ok: false, error: "codex returned no structured output" };
        return { ok: true, value: clean(value, schema, schema) };
      } finally {
        if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    return sessions(host, runOnce);
  },
});
