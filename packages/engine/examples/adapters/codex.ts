import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapter, type Action, type ActionKind } from "penguin";
import { modelFor, type ModelMap } from "../helpers/models.ts";
import { priced } from "../helpers/prices.ts";
import {
  clip,
  compactTokens,
  flatten,
  said,
  sessions,
  type Attempt,
  type Chunk,
  type Invocation,
  type Usage,
} from "../helpers/turns.ts";

type OpenOptions = {
  cwd?: string;
  model?: string;
  sandbox?: string;
  /**
   * The context size the session compacts itself at: "200k", "1M", or a token count. "auto" keeps
   * codex's own limit.
   */
  autocompact?: string;
};

const MODELS = {
  small: "gpt-5.6-terra",
  normal: "gpt-5.6-sol",
  big: "gpt-5.6-sol",
} satisfies ModelMap;

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

type TokenUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
};
type StreamLine = {
  type?: string;
  thread_id?: string;
  item?: Item;
  error?: { message?: string };
  message?: string;
  /** On turn.completed: the turn's tokens. input_tokens includes the cached ones. */
  usage?: TokenUsage;
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

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageOf(tokens: TokenUsage, model: string | undefined): Usage {
  const cached = count(tokens.cached_input_tokens);
  const written = count(tokens.cache_write_input_tokens);
  return {
    ...(model === undefined ? {} : { model }),
    input: Math.max(0, count(tokens.input_tokens) - cached - written),
    cacheRead: cached,
    cacheWrite: written,
    output: count(tokens.output_tokens),
  };
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
  async check(host) {
    const there = await host.shell("command -v codex");
    return there.code === 0 ? [] : ["codex is not installed or not on PATH."];
  },
  description:
    "runs prompts on the codex CLI. A session is one conversation: the first turn starts a codex thread, later turns resume it.",
  build: (host) => {
    async function runOnce(
      invocation: Invocation<OpenOptions>,
      emit: (chunk: Chunk) => void,
    ): Promise<Attempt> {
      const { options, prompt, schema, signal } = invocation;
      let thread = invocation.thread;
      const argv = ["codex", "exec"];
      if (thread !== undefined) argv.push("resume", thread);
      argv.push("--json", "--skip-git-repo-check");
      const model = modelFor(options.model, "codex", MODELS, host.config);
      if (model !== undefined) argv.push("-c", `model="${model}"`);
      // A run has no one to ask, and workspace-write blocks .git writes and the network.
      argv.push("-c", `sandbox_mode="${options.sandbox ?? "danger-full-access"}"`);
      const compactAt = compactTokens(options.autocompact);
      if (compactAt !== undefined) {
        argv.push("-c", `model_auto_compact_token_limit=${compactAt}`);
      }
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
        let usage: Usage | undefined;
        const handle = (line: string): void => {
          const parsed = readJson(line);
          if (!isObject(parsed)) return;
          const event = parsed as StreamLine;
          if (said(event.thread_id) && event.thread_id !== thread) {
            thread = event.thread_id;
            invocation.keep(thread);
          }
          if (event.type === "turn.completed" && event.usage !== undefined) {
            usage = priced(usageOf(event.usage, model), host.config);
          }
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

        const spent = usage === undefined ? {} : { usage };
        if (done.code !== 0) {
          const tail = done.stderr.trim().split("\n").at(-1) ?? "";
          return {
            ok: false,
            error:
              tail === ""
                ? `codex exited with code ${done.code}`
                : `codex exited with code ${done.code}: ${tail}`,
            ...spent,
          };
        }
        // Only a turn.failed or an error event sets this, both of them the provider's refusal.
        if (failed !== undefined) return { ok: false, error: failed, pause: "error", ...spent };
        if (schema === undefined) return { ok: true, value: null, ...spent };
        const value = message === undefined ? undefined : structured(message);
        if (value === undefined) {
          return { ok: false, error: "codex returned no structured output", ...spent };
        }
        return { ok: true, value: clean(value, schema, schema), ...spent };
      } finally {
        if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    return sessions(host, runOnce, "codex");
  },
});
