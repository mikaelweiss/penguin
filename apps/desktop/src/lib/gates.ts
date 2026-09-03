import { invoke } from "@tauri-apps/api/core";

/** The project's gates from ~/.penguin/gates as they were written, undefined when the project has none. */
export function readGates(dir: string): Promise<string | undefined> {
  return invoke<string | null>("read_gates", { dir }).then((text) => text ?? undefined);
}

/** Writes the gate file whole, creating its folder and closing the last line. */
export function writeGates(dir: string, text: string): Promise<void> {
  return invoke("write_gates", { dir, text });
}

/** What the file holds after a save, since the command closes the last line. */
export function ended(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

const SCOPED = /^\[([^\]]*)\]\s*(.*)$/;

/** A line meant as a gate that the engine will not run as one, and why. */
export type Trouble = { line: number; detail: string };

/**
 * What the parser makes of a line a person wrote as a gate. A blank line and a `#`
 * line are skipped on purpose, so neither is trouble.
 */
export function troubles(text: string): Trouble[] {
  const found: Trouble[] = [];
  text.split("\n").forEach((raw, at) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const scoped = SCOPED.exec(line);
    if (scoped === null) {
      if (line.startsWith("[")) {
        found.push({
          line: at + 1,
          detail: "the scope never closes, so the bracket runs as part of the command",
        });
      }
      return;
    }
    if ((scoped[2] ?? "").trim() === "") {
      found.push({ line: at + 1, detail: "a scope with no command after it is not a gate" });
    }
  });
  return found;
}
