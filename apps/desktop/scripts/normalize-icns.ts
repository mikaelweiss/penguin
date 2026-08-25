// tauri-cli serialises the icns entry table from an unordered map, so two runs over one SVG emit
// the same images in a different order. Sorting by OSType is what makes `bun run icon` idempotent.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const icns = path.join(desktop, "src-tauri", "icons", "icon.icns");

function fail(problem: string): never {
  console.error(problem);
  process.exit(1);
}

const file = fs.readFileSync(icns);
if (file.subarray(0, 4).toString("latin1") !== "icns") fail(`${icns} is not an icns file`);
if (file.readUInt32BE(4) !== file.length) fail(`${icns} declares a length it does not have`);

const entries: { type: string; bytes: Buffer }[] = [];
for (let at = 8; at < file.length; ) {
  const length = file.readUInt32BE(at + 4);
  if (length < 8 || at + length > file.length) fail(`${icns} has a malformed entry at byte ${at}`);
  const type = file.subarray(at, at + 4).toString("latin1");
  // A table of contents records the order it was written in, so reordering behind it would lie.
  if (type === "TOC ") fail(`${icns} carries a table of contents this script cannot reorder`);
  entries.push({ type, bytes: file.subarray(at, at + length) });
  at += length;
}

entries.sort((one, other) => (one.type < other.type ? -1 : 1));
fs.writeFileSync(icns, Buffer.concat([file.subarray(0, 8), ...entries.map(({ bytes }) => bytes)]));
console.log(`ordered ${entries.length} icns entries`);
