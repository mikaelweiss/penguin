import fs from "node:fs";
import path from "node:path";
import { PenguinError } from "./errors.ts";
import { credentialFile, credentialsDir, short } from "./paths.ts";

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Where penguin keeps the credential, for a human to read. */
export function where(name: string): string {
  return short(credentialFile(checked(name)));
}

export function read(name: string): Record<string, string> {
  const file = credentialFile(checked(name));
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};
  const values: Record<string, string> = {};
  for (const [field, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value !== "") values[field] = value;
  }
  return values;
}

export function save(name: string, values: Record<string, string>): string {
  const kept = read(name);
  const file = credentialFile(checked(name));
  fs.mkdirSync(credentialsDir(), { recursive: true });
  fs.chmodSync(credentialsDir(), 0o700);
  fs.writeFileSync(file, `${JSON.stringify({ ...kept, ...values }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return short(file);
}

/** Write the file with every field name, so a user who opens it sees the shape. */
export function seed(name: string, fields: string[]): void {
  const kept = read(name);
  const values: Record<string, string> = {};
  for (const field of fields) values[field] = kept[field] ?? "";
  save(name, values);
}

export function forget(name: string): void {
  fs.rmSync(credentialFile(checked(name)), { force: true });
}

function checked(name: string): string {
  if (!NAME.test(name)) {
    throw new PenguinError(
      `"${name}" is not a credential name. A name is lowercase letters, digits, and dashes.`,
    );
  }
  return path.basename(name);
}
