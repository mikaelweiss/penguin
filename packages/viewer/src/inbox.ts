import { inboxPath } from "@mikaelweiss/penguin-engine/protocol";
import fs from "node:fs";

/** One message into the run, addressed to a gate, to a session, or to the run. */
export function deliver(dir: string, text: string, to?: { session?: string; gate?: string }): void {
  const message = {
    at: new Date().toISOString(),
    text,
    session: to?.session,
    gate: to?.gate,
  };
  fs.appendFileSync(inboxPath(dir), `${JSON.stringify(message)}\n`);
}

/** The run hears only that the credential store holds the values now. */
export function provide(dir: string, name: string): void {
  const notice = { at: new Date().toISOString(), credential: name };
  fs.appendFileSync(inboxPath(dir), `${JSON.stringify(notice)}\n`);
}
