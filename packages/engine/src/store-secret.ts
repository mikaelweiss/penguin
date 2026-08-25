// The secret-write entrypoint. A frontend spawns `bun store-secret.ts <name>`
// with the value on stdin, so the engine's own binary creates the keychain item
// and stays its only silent reader.
import { secrets } from "bun";

const name = process.argv[2];
if (name === undefined || name === "") {
  console.error("store-secret takes a name");
  process.exit(2);
}

const value = await Bun.stdin.text();
if (value === "") {
  console.error("store-secret takes the value on stdin");
  process.exit(2);
}

try {
  await secrets.set({ service: "penguin", name, value });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
