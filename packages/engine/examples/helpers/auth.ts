import fs from "node:fs";
import path from "node:path";
import type { Host } from "penguin";

/** One input the app draws when a run waits on credentials. `secret` hides what is typed. */
export type Field = { name: string; label: string; placeholder?: string; secret?: boolean };

export type Help = { label: string; url: string };

export type Gate = {
  /** Notes the pause once, then every caller waits for the app to save. Resolves after a save. */
  pause(reason: string): Promise<void>;
};

/**
 * The wait an adapter makes when nothing it holds is accepted: one note tells the app what
 * fields to ask for, the app saves them to the keychain under the role's name and touches the
 * epoch file, and every paused caller reads the keychain again. `onSave` runs once per save.
 */
export function authGate(
  host: Host,
  role: string,
  options: { fields: Field[]; help?: Help; onSave?: () => void },
): Gate {
  const epoch = path.join(host.state, "auth", role);
  let waiting: Promise<void> | undefined;

  const epochValue = (): string => {
    try {
      return fs.readFileSync(epoch, "utf8");
    } catch {
      return "";
    }
  };

  return {
    pause(reason: string): Promise<void> {
      if (waiting !== undefined) return waiting;
      const since = epochValue();
      host.note({ auth: { role, reason, fields: options.fields, ...(options.help === undefined ? {} : { help: options.help }) } });
      waiting = new Promise<void>((resolve) => {
        const check = (): void => {
          if (epochValue() === since) return;
          fs.unwatchFile(epoch, check);
          resolve();
        };
        fs.watchFile(epoch, { interval: 500 }, check);
        check();
      }).then(() => {
        options.onSave?.();
        host.note({ auth: { role, resolved: true } });
        waiting = undefined;
      });
      return waiting;
    },
  };
}

/** The keychain item the app saves: one JSON object of the fields it asked for. */
export async function storedFields(host: Host, role: string): Promise<Record<string, string>> {
  const raw = await host.secret(role);
  if (raw === undefined) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
  const held: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value !== "") held[key] = value;
  }
  return held;
}
