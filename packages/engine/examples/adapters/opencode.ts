import crypto from "node:crypto";
import path from "node:path";
import { adapter, type Action, type ActionKind } from "penguin";
import { modelFor } from "../helpers/models.ts";
import {
  clip,
  said,
  sessions,
  targetIn,
  type Attempt,
  type Chunk,
  type Invocation,
  type Usage,
} from "../helpers/turns.ts";

type OpenOptions = {
  cwd?: string;
  model?: string;
  agent?: string;
};

type ToolState = {
  status?: string;
  input?: unknown;
  output?: string;
  error?: unknown;
};
type Tokens = {
  input?: number;
  output?: number;
  cache?: { read?: number; write?: number };
};
type Part = {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  state?: ToolState;
  /** On a step-finish part: what that model call cost. A turn is the sum of its steps. */
  tokens?: Tokens;
  cost?: number;
};
type StreamLine = {
  type?: string;
  sessionID?: string;
  part?: Part;
  error?: unknown;
};

/** Only this adapter knows opencode's tool shapes. */
const target = targetIn([
  "command",
  "filePath",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
]);

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** The turn's usage so far with one more step added in. */
function added(total: Usage | undefined, part: Part, model: string | undefined): Usage {
  const tokens = part.tokens ?? {};
  const base: Usage = total ?? {
    ...(model === undefined ? {} : { model }),
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    usd: 0,
  };
  return {
    ...base,
    input: base.input + count(tokens.input),
    cacheRead: base.cacheRead + count(tokens.cache?.read),
    cacheWrite: base.cacheWrite + count(tokens.cache?.write),
    output: base.output + count(tokens.output),
    usd: Math.round(((base.usd ?? 0) + count(part.cost)) * 1e6) / 1e6,
  };
}

function reason(error: unknown): string {
  if (said(error)) return error;
  if (error === null || typeof error !== "object") return "opencode reported an error";
  const values = error as {
    name?: unknown;
    message?: unknown;
    data?: { message?: unknown; ref?: unknown };
  };
  const held = values.message ?? values.data?.message;
  const message = said(held) ? held : JSON.stringify(error);
  const named = said(values.name) ? `${values.name}: ${message}` : message;
  const ref = values.data?.ref;
  return said(ref) ? `${named} (ref ${ref})` : named;
}

/**
 * opencode answers a server defect with a generic 500 and a ref, keeping the cause in its own
 * logs. --print-logs copies that cause to stderr, which the run file would otherwise never hold.
 */
function loggedCause(stderr: string): string | undefined {
  for (const line of stderr.split("\n").reverse()) {
    if (!line.includes("message=failed")) continue;
    const match = /(?:^|\s)error=("(?:\\.|[^"\\])*"|\S+)/.exec(line);
    if (match === null) continue;
    const raw = match[1] ?? "";
    const cause = raw.startsWith('"') ? unquote(raw) : raw;
    if (said(cause)) return cause;
  }
  return undefined;
}

function unquote(value: string): string {
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

const KINDS: Record<string, ActionKind> = {
  bash: "run",
  shell: "run",
  read: "read",
  list: "read",
  edit: "edit",
  write: "edit",
  patch: "edit",
  apply_patch: "edit",
  grep: "search",
  glob: "search",
  webfetch: "fetch",
  websearch: "fetch",
  task: "agent",
};

function act(part: Part, id: string): Action {
  const state = part.state;
  const status =
    state?.status === "error" ? "failed" : state?.status === "completed" ? "done" : "running";
  const kind = KINDS[part.tool ?? ""];
  const acted = target(state?.input);
  const returned = state?.output;
  const raw = status === "failed" ? reason(state?.error) : said(returned) ? returned : "";
  const output = status === "running" ? "" : clip(raw.trim());
  return {
    id,
    name: part.tool ?? "tool",
    status,
    ...(kind === undefined ? {} : { kind }),
    ...(acted === undefined ? {} : { target: acted }),
    ...(output === "" ? {} : { output }),
  };
}

/** Every JSON the reply could hold, last block first: a model often shows an example before the answer. */
function candidates(text: string): string[] {
  const found = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
    .map((match) => match[1] ?? "")
    .reverse();
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open !== -1 && close > open) found.push(text.slice(open, close + 1));
  return found;
}

function structured(text: string): unknown {
  for (const candidate of candidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return undefined;
}

function asked(prompt: string, schema: Record<string, unknown> | undefined): string {
  if (schema === undefined) return prompt;
  return `${prompt}\n\nReply with one JSON object and no other text. It must match this JSON Schema:\n${JSON.stringify(schema)}`;
}

export default adapter({
  role: "agent",
  name: "opencode",
  async check(host) {
    const there = await host.shell("command -v opencode");
    return there.code === 0 ? [] : ["opencode is not installed or not on PATH."];
  },
  description:
    "runs prompts on the opencode CLI. A session is one conversation: the first turn opens it, later turns resume it over --session. The CLI takes no schema, so a typed result is asked for in the prompt and read back out of the reply.",
  build: (host) => {
    async function runOnce(
      invocation: Invocation<OpenOptions>,
      emit: (chunk: Chunk) => void,
    ): Promise<Attempt> {
      const { options, prompt, schema, signal } = invocation;
      const argv = ["opencode", "run", "--auto", "--format", "json", "--print-logs"];
      let id = invocation.thread;
      if (id !== undefined) argv.push("--session", id);
      const model = modelFor(options.model, "opencode", {}, host.config);
      if (model !== undefined) argv.push("--model", model);
      if (options.agent !== undefined) argv.push("--agent", options.agent);

      let buffer = "";
      let text = "";
      let failed: string | undefined;
      let usage: Usage | undefined;
      const handle = (line: string): void => {
        if (line.trim() === "") return;
        let event: StreamLine;
        try {
          event = JSON.parse(line) as StreamLine;
        } catch {
          return;
        }
        const opening = event.sessionID;
        if (said(opening) && opening !== id) {
          id = opening;
          invocation.keep(id);
        }
        const part = event.part;
        const body = part?.text;
        if (event.type === "text" && said(body)) {
          text += body;
          emit({ kind: "text", text: body });
        }
        if (event.type === "reasoning" && said(body)) {
          emit({ kind: "thinking", text: body });
        }
        if (event.type === "tool_use" && part?.tool !== undefined) {
          emit({ kind: "tool", call: act(part, part.id ?? crypto.randomUUID()) });
        }
        if (event.type === "step_finish" && part !== undefined) usage = added(usage, part, model);
        if (event.type === "error") failed = reason(event.error);
      };

      const done = await host.exec(argv, {
        cwd: path.resolve(host.cwd, options.cwd ?? "."),
        stdin: asked(prompt, schema),
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
      /** The reason rides an error event on stdout; --print-logs puts the cause it omits on stderr. */
      if (failed !== undefined) {
        const cause = loggedCause(done.stderr);
        const error = cause === undefined || failed.includes(cause) ? failed : `${failed}\n${cause}`;
        return { ok: false, error, pause: "error", ...spent };
      }
      if (done.code !== 0) {
        const tail = done.stderr.trim().split("\n").at(-1) ?? "";
        return {
          ok: false,
          error:
            tail === ""
              ? `opencode exited with code ${done.code}`
              : `opencode exited with code ${done.code}: ${tail}`,
          ...spent,
        };
      }
      if (schema === undefined) return { ok: true, value: null, ...spent };
      const value = structured(text);
      if (value === undefined) {
        return { ok: false, error: "opencode returned no JSON result", ...spent };
      }
      return { ok: true, value, ...spent };
    }

    return sessions(host, runOnce, "opencode");
  },
});
