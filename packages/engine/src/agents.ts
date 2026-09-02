import type { AdapterFound } from "./catalog/adapters.ts";
import type { Host } from "./core/adapter.ts";
import { messageOf } from "./core/errors.ts";

export type AgentApi = {
  open(options?: Record<string, unknown>): Promise<string>;
  turn(session: string, ...rest: unknown[]): unknown;
  stop(session: string): Promise<void>;
};

function withoutAdapter(
  options: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (options === undefined || !("adapter" in options)) return options;
  const rest = { ...options };
  delete rest["adapter"];
  return rest;
}

/**
 * One ctx.agent over every installed agent adapter. A named adapter that is missing, fails its
 * check, or will not build falls back to the configured one, so only the configured one can
 * block a run.
 */
export function routeAgents(host: Host, found: AdapterFound[], chosen: AdapterFound): AgentApi {
  const byName = new Map(
    found.filter((entry) => entry.role === chosen.role).map((entry) => [entry.name, entry]),
  );
  const built = new Map<string, AgentApi>();
  const probes = new Map<string, Promise<string[]>>();
  const told = new Set<string>();
  const owners = new Map<string, AgentApi>();

  function build(entry: AdapterFound): AgentApi {
    const held = built.get(entry.name);
    if (held !== undefined) return held;
    const api = entry.definition.build(host) as AgentApi;
    built.set(entry.name, api);
    return api;
  }

  const configured = build(chosen);

  /** Asked once: a CLI does not install itself mid-run. */
  function probe(entry: AdapterFound): Promise<string[]> {
    const held = probes.get(entry.name);
    if (held !== undefined) return held;
    const asked = (async () => {
      try {
        return (await entry.definition.check?.(host)) ?? [];
      } catch (error) {
        return [messageOf(error)];
      }
    })();
    probes.set(entry.name, asked);
    return asked;
  }

  function fell(wanted: string, reason: string): AgentApi {
    // The reason cannot change within a run, so one note per named adapter says it.
    if (!told.has(wanted)) {
      told.add(wanted);
      host.note({ fallback: { role: chosen.role, wanted, used: chosen.name, reason } });
    }
    return configured;
  }

  async function reach(wanted: string): Promise<AgentApi> {
    if (wanted === chosen.name) return configured;
    const entry = byName.get(wanted);
    if (entry === undefined) {
      return fell(wanted, `no ${chosen.role} adapter named ${wanted} is installed`);
    }
    const problems = await probe(entry);
    if (problems.length > 0) return fell(wanted, problems.join(" "));
    try {
      return build(entry);
    } catch (error) {
      return fell(wanted, messageOf(error));
    }
  }

  /**
   * A session id the router never handed out came off a replayed run file. The configured adapter
   * refuses it by name.
   */
  function owner(session: string): AgentApi {
    return owners.get(session) ?? configured;
  }

  return {
    async open(options?: Record<string, unknown>): Promise<string> {
      const wanted = options?.["adapter"];
      const api = typeof wanted === "string" ? await reach(wanted) : configured;
      const session = await api.open(withoutAdapter(options));
      owners.set(session, api);
      return session;
    },
    turn: (session, ...rest) => owner(session).turn(session, ...rest),
    stop: (session) => owner(session).stop(session),
  };
}
