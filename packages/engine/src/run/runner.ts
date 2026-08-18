import { PenguinError, messageOf } from "../errors.ts";
import { execute } from "./execute.ts";

const [name] = process.argv.slice(2);

try {
  if (name === undefined) throw new PenguinError("the run process needs a run name");
  process.exit(await execute(name));
} catch (error) {
  process.stderr.write(`penguin: ${messageOf(error)}\n`);
  process.exit(1);
}
