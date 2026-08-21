import { installedIn, pick } from "./catalog/adapters.ts";
import { roots, type Catalog } from "./catalog/catalogs.ts";
import { load } from "./catalog/loader.ts";
import { PenguinError } from "./core/errors.ts";
import { createHost } from "./host.ts";
import { createTrace } from "./trace.ts";

export { createHost } from "./host.ts";

export type RunOptions = {
  /** The run's invoking folder. Defaults to the process's. */
  cwd?: string;
  /** The catalogs to draw adapters from. Defaults to roots(cwd). */
  catalogs?: Catalog[];
  /** false skips the trace log. */
  trace?: boolean;
};

/** Loads one workflow file, validates its params, wires the installed adapters onto ctx, and runs it. */
export async function run(
  file: string,
  params: unknown = {},
  options?: RunOptions,
): Promise<unknown> {
  const cwd = options?.cwd ?? process.cwd();
  const definition = await load(file);
  const parsed: unknown = definition.params.parse(params);
  const host = createHost(cwd);
  const trace = options?.trace === false ? undefined : createTrace();
  const found = await installedIn(options?.catalogs ?? roots(cwd));
  const ctx: Record<string, unknown> = { params: parsed };
  for (const role of new Set(found.map((entry) => entry.role))) {
    const picked = pick(found, role);
    if ("missing" in picked) throw new PenguinError(picked.missing);
    if ("conflict" in picked) throw new PenguinError(picked.conflict);
    const built = picked.found.definition.build(host);
    ctx[role] = trace === undefined ? built : trace.wrap(role, built);
  }
  trace?.note({ workflow: file, params: parsed });
  try {
    // The loader duck-typed the definition, so its schema's static type is gone here.
    const result = await definition.run(ctx as never);
    trace?.note({ outcome: result });
    return result;
  } catch (error) {
    trace?.note({ threw: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
