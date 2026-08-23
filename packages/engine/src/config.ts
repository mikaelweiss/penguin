import fs from "node:fs";
import { configFile } from "./paths.ts";

/** ~/.penguin/config: one "key value" per line, blanks and # comments skipped. */
export function readConfig(): Map<string, string> {
  const file = configFile();
  const map = new Map<string, string>();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const text = line.trim();
    if (text === "" || text.startsWith("#")) continue;
    const split = text.search(/\s/);
    if (split === -1) continue;
    map.set(text.slice(0, split), text.slice(split).trim());
  }
  return map;
}
