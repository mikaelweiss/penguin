import { spawn } from "node:child_process";

/** Hand the terminal to the user's editor, and take it back when they leave. */
export function openEditor(file: string): Promise<number> {
  const editor = process.env["VISUAL"] ?? process.env["EDITOR"] ?? "vi";
  const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
  return new Promise((resolve) => {
    const child = spawn(`${editor} ${quoted}`, { shell: true, stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
