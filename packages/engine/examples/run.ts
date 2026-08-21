// Runs one workflow in the foreground with the starter adapters.
// usage: bun examples/run.ts examples/workflows/commit.ts '{"dir":"."}'
import { starterCatalog } from "../src/catalog/catalogs.ts";
import { messageOf } from "../src/core/errors.ts";
import { run } from "../src/run.ts";

const [file, json] = process.argv.slice(2);
if (file === undefined) {
  process.stderr.write("usage: bun examples/run.ts <workflow.ts> ['{...params}']\n");
  process.exit(2);
}

try {
  const result = await run(file, json === undefined ? {} : JSON.parse(json), {
    catalogs: [starterCatalog()],
  });
  process.stdout.write(`\n${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
} catch (error) {
  process.stderr.write(`penguin: ${messageOf(error)}\n`);
  process.exit(1);
}
