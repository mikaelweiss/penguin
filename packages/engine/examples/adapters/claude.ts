import crypto from "node:crypto";
import path from "node:path";
import { adapter, type Action, type ActionKind, type CommandResult, type Process } from "penguin";
import { modelFor, type ModelMap } from "../helpers/models.ts";
import {
  clip,
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
  permission?: string;
  /** The tools the session may use. An empty list leaves a turn that only answers, which is the fastest one runs. */
  tools?: string[];
  /**
   * Which of the CLI's own setting sources the session loads. An empty list is a
   * session carrying nothing but this workflow's prompt: no user instructions, no
   * MCP servers, no plugins. A person's interactive setup is theirs, not a run's.
   */
  settings?: string[];
  /** How hard the model works before it answers: low, medium, high, xhigh, or max. */
  effort?: string;
  /** How long the prompt cache holds between turns: "5m" or "1h". */
  cacheTtl?: string;
  /** The context size the session compacts itself at: "auto", or 100k to 1M tokens. */
  autocompact?: string;
};

const MODELS = { small: "sonnet", normal: "opus", big: "fable" } satisfies ModelMap;

/** Turns seconds apart hold the 5 minute tier, which writes cheaper than the CLI's 1 hour default. */
const CACHE_TTL = "5m";

type ContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
};
type TokenUsage = {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
};
type ModelUsage = Record<
  string,
  {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }
>;
type StreamLine = {
  type?: string;
  is_error?: boolean;
  result?: unknown;
  errors?: unknown;
  structured_output?: unknown;
  message?: { content?: ContentBlock[] };
  /** The wrapper fields claude puts beside an assistant message it built from an API error. */
  is_api_error_message?: boolean;
  error?: string;
  /** This turn's tokens. */
  usage?: TokenUsage;
  /** Running totals for the process, so a turn's share is the growth since the last result. */
  total_cost_usd?: number;
  modelUsage?: ModelUsage;
  /** On a rate_limit_event: the window that applies and when it resets, in unix seconds. */
  rate_limit_info?: { resetsAt?: number };
};

/** One claude process, kept open across the turns of a session that share a schema. */
type Live = {
  key: string;
  child: Process;
  controller: AbortController;
  exited: boolean;
  /** What the last result reported, so the next turn reports only its own growth. */
  costUsd: number;
  modelTokens: Map<string, number>;
  /** When the usage window the CLI last reported resets, in unix seconds. */
  resetsAt: number | undefined;
  /** The turn reading the stream now. */
  onLine: ((line: string) => void) | undefined;
  onExit: ((done: CommandResult) => void) | undefined;
};

/** Only this adapter knows claude's tool shapes. */
const target = targetIn([
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "skill",
  "description",
  "prompt",
]);

const KINDS: Record<string, ActionKind> = {
  Bash: "run",
  BashOutput: "run",
  Read: "read",
  NotebookRead: "read",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Grep: "search",
  Glob: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  Task: "agent",
  Agent: "agent",
};

/** What a failed result says: the success field, else the error subtypes' list. */
function reported(event: StreamLine): string {
  if (typeof event.result === "string" && event.result.trim() !== "") return event.result;
  if (Array.isArray(event.errors)) {
    const said = event.errors.map(String).filter((line) => line.trim() !== "");
    if (said.length > 0) return said.join("; ");
  }
  return "claude reported an error";
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: ContentBlock) => (block?.type === "text" ? (block.text ?? "") : ""))
    .filter((text) => text !== "")
    .join("\n");
}

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function tokensOf(entry: ModelUsage[string]): number {
  return (
    count(entry.inputTokens) +
    count(entry.outputTokens) +
    count(entry.cacheReadInputTokens) +
    count(entry.cacheCreationInputTokens)
  );
}

/** The model this turn ran on: the one whose running total grew the most since the last result. */
function grownModel(live: Live, reported: ModelUsage | undefined): string | undefined {
  if (reported === undefined) return undefined;
  let best: { model: string; grew: number } | undefined;
  for (const [model, entry] of Object.entries(reported)) {
    const now = tokensOf(entry);
    const grew = now - (live.modelTokens.get(model) ?? 0);
    live.modelTokens.set(model, now);
    if (best === undefined || grew > best.grew) best = { model, grew };
  }
  return best?.model;
}

function usageOf(event: StreamLine, live: Live, model: string | undefined): Usage | undefined {
  const tokens = event.usage;
  if (tokens === undefined) return undefined;
  const usage: Usage = {
    input: count(tokens.input_tokens),
    cacheRead: count(tokens.cache_read_input_tokens),
    cacheWrite: count(tokens.cache_creation_input_tokens),
    output: count(tokens.output_tokens),
  };
  const named = grownModel(live, event.modelUsage) ?? model;
  if (named !== undefined) usage.model = named;
  if (typeof event.total_cost_usd === "number") {
    const grew = Math.max(0, event.total_cost_usd - live.costUsd);
    live.costUsd = event.total_cost_usd;
    usage.usd = Math.round(grew * 1e6) / 1e6;
  }
  return usage;
}

/** Every process any build of this adapter holds open. A run that ends must not leave an agent editing files. */
const open = new Set<Live>();
process.on("exit", () => {
  for (const live of open) live.controller.abort();
});

function exitFailure(done: CommandResult): string {
  const tail = done.stderr.trim().split("\n").at(-1) ?? "";
  return tail === ""
    ? `claude exited with code ${done.code}`
    : `claude exited with code ${done.code}: ${tail}`;
}

export default adapter({
  role: "agent",
  name: "claude",
  async check(host) {
    const there = await host.shell("command -v claude");
    return there.code === 0 ? [] : ["claude is not installed or not on PATH."];
  },
  description:
    "runs prompts on the claude CLI. A session is one conversation held by one CLI process: every turn goes down its stdin, and a process that ended is resumed by session id.",
  build: (host) => {
    const lives = new Map<string, Live>();

    function start(
      session: string,
      first: boolean,
      options: OpenOptions,
      schema: Record<string, unknown> | undefined,
      key: string,
    ): Live {
      const argv = [
        "claude",
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ];
      if (schema !== undefined) argv.push("--json-schema", JSON.stringify(schema));
      argv.push(first ? "--session-id" : "--resume", session);
      const model = modelFor(options.model, "claude", MODELS, host.config);
      if (model !== undefined) argv.push("--model", model);
      // The flag is variadic, so an empty set has to arrive as one argument carrying nothing.
      if (options.tools !== undefined) {
        argv.push(...(options.tools.length === 0 ? ["--tools="] : ["--tools", ...options.tools]));
      }
      if (options.settings !== undefined) {
        argv.push(`--setting-sources=${options.settings.join(",")}`);
      }
      if (options.effort !== undefined) argv.push("--effort", options.effort);
      if (options.autocompact !== undefined) argv.push("--autocompact", options.autocompact);
      // A run has no one to ask, so any prompt is a denial. `permission` overrides it.
      argv.push("--permission-mode", options.permission ?? "bypassPermissions");

      const controller = new AbortController();
      let buffer = "";
      const live: Live = {
        key,
        child: undefined as unknown as Process,
        controller,
        exited: false,
        costUsd: 0,
        modelTokens: new Map(),
        resetsAt: undefined,
        onLine: undefined,
        onExit: undefined,
      };
      live.child = host.spawn(argv, {
        cwd: path.resolve(host.cwd, options.cwd ?? "."),
        signal: controller.signal,
        env: {
          CLAUDE_CODE_PROMPT_CACHE_TTL:
            options.cacheTtl ?? host.config("claude-cache-ttl") ?? CACHE_TTL,
        },
        onOutput: (chunk, stream) => {
          if (stream !== "stdout") return;
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) live.onLine?.(line);
        },
      });
      const ended = (done: CommandResult): void => {
        if (buffer.trim() !== "") live.onLine?.(buffer);
        buffer = "";
        live.exited = true;
        open.delete(live);
        if (lives.get(session) === live) lives.delete(session);
        live.onExit?.(done);
      };
      live.child.exited.then(ended, (error: unknown) => {
        ended({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) });
      });
      lives.set(session, live);
      open.add(live);
      return live;
    }

    function retire(session: string, live: Live): void {
      if (lives.get(session) === live) lives.delete(session);
      live.onLine = undefined;
      live.onExit = undefined;
      if (!live.exited) live.child.end();
    }

    async function runOnce(
      invocation: Invocation<OpenOptions>,
      emit: (chunk: Chunk) => void,
    ): Promise<Attempt> {
      const { session, first, options, prompt, schema, signal } = invocation;
      const key = schema === undefined ? "" : JSON.stringify(schema);
      const held = lives.get(session);
      // The result tool is fixed when the process starts, so a new schema needs a new process.
      if (held !== undefined && (held.exited || held.key !== key)) retire(session, held);
      const live = lives.get(session) ?? start(session, first, options, schema, key);
      const model = modelFor(options.model, "claude", MODELS, host.config);

      let value: unknown;
      let failed: string | undefined;
      let limited: string | undefined;
      let apiError: string | undefined;
      let usage: Usage | undefined;
      const calls = new Map<string, Action>();
      const handle = (line: string): boolean => {
        if (line.trim() === "") return false;
        let event: StreamLine;
        try {
          event = JSON.parse(line) as StreamLine;
        } catch {
          return false;
        }
        if (event.type === "rate_limit_event") {
          const resets = event.rate_limit_info?.resetsAt;
          if (typeof resets === "number") live.resetsAt = resets;
          return false;
        }
        if (event.type === "assistant") {
          // What the API refused is the pause's reason, not part of the story.
          if (event.is_api_error_message === true) {
            const said = resultText(event.message?.content).trim();
            if (event.error === "rate_limit") limited = said;
            else apiError = said === "" ? (event.error ?? "claude hit an API error") : said;
            return false;
          }
          for (const block of event.message?.content ?? []) {
            if (block.type === "text" && block.text !== undefined && block.text !== "") {
              emit({ kind: "text", text: block.text });
            }
            if (block.type === "thinking" && block.thinking !== undefined && block.thinking !== "") {
              emit({ kind: "thinking", text: block.thinking });
            }
            if (block.type === "tool_use" && block.name !== undefined) {
              const kind = KINDS[block.name];
              const acted = target(block.input);
              const call: Action = {
                id: block.id ?? crypto.randomUUID(),
                name: block.name,
                status: "running",
                ...(kind === undefined ? {} : { kind }),
                ...(acted === undefined ? {} : { target: acted }),
              };
              calls.set(call.id, call);
              emit({ kind: "tool", call });
            }
          }
        }
        if (event.type === "user") {
          for (const block of event.message?.content ?? []) {
            if (block.type !== "tool_result" || block.tool_use_id === undefined) continue;
            const call = calls.get(block.tool_use_id);
            if (call === undefined) continue;
            const output = clip(resultText(block.content).trim());
            emit({
              kind: "tool",
              call: {
                ...call,
                status: block.is_error === true ? "failed" : "done",
                ...(output === "" ? {} : { output }),
              },
            });
          }
        }
        if (event.type === "result") {
          if (event.is_error === true) failed = reported(event);
          value = event.structured_output;
          usage = usageOf(event, live, model);
          return true;
        }
        return false;
      };

      const settled = ((): string | undefined => {
        if (failed !== undefined) return failed;
        if (schema !== undefined && value === undefined) {
          return "claude returned no structured output";
        }
        return undefined;
      });

      const outcome = await new Promise<{ exit?: CommandResult }>((resolve) => {
        const stop = (): void => live.controller.abort();
        signal.addEventListener("abort", stop, { once: true });
        const finish = (exit?: CommandResult): void => {
          signal.removeEventListener("abort", stop);
          live.onLine = undefined;
          live.onExit = undefined;
          resolve(exit === undefined ? {} : { exit });
        };
        live.onLine = (line) => {
          if (handle(line)) finish();
        };
        live.onExit = (done) => finish(done);
        if (signal.aborted) {
          stop();
          return;
        }
        live.child.write(
          `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`,
        );
      });

      const failure =
        outcome.exit !== undefined && outcome.exit.code !== 0 ? exitFailure(outcome.exit) : settled();
      const spent = usage === undefined ? {} : { usage };
      if (failure === undefined) return { ok: true, value: value ?? null, ...spent };
      if (limited !== undefined) {
        const said = limited === "" ? "claude hit its usage limit" : limited;
        const until =
          live.resetsAt === undefined ? {} : { until: new Date(live.resetsAt * 1000).toISOString() };
        return { ok: false, error: said, pause: "limit", ...until, ...spent };
      }
      if (apiError !== undefined) return { ok: false, error: apiError, pause: "error", ...spent };
      return { ok: false, error: failure, ...spent };
    }

    return sessions(host, runOnce, "claude");
  },
});
