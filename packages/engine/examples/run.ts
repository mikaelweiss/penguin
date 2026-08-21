// Runs one workflow in the foreground with the starter adapters.
// usage: bun examples/run.ts examples/workflows/commit.ts '{"dir":"."}'
import { installedIn } from "../src/catalog/adapters.ts";
import { starterCatalog } from "../src/catalog/catalogs.ts";
import { load } from "../src/catalog/loader.ts";
import { messageOf } from "../src/core/errors.ts";
import { createHost } from "../src/host.ts";

const [file, json] = process.argv.slice(2);
if (file === undefined) {
  process.stderr.write("usage: bun examples/run.ts <workflow.ts> ['{...params}']\n");
  process.exit(2);
}

try {
  const definition = await load(file);
  const params: unknown = definition.params.parse(json === undefined ? {} : JSON.parse(json));
  const host = createHost(process.cwd());
  const ctx: Record<string, unknown> = { params };
  for (const entry of await installedIn([starterCatalog()])) {
    ctx[entry.role] ??= entry.definition.build(host);
  }
  const result = await (definition.run as (ctx: unknown) => Promise<unknown>)(ctx);
  process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
} catch (error) {
  process.stderr.write(`penguin: ${messageOf(error)}\n`);
  process.exit(1);
}
