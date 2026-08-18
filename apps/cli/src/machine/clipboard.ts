import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const ROOM = 64 * 1024 * 1024;

/** Where the pasted image landed, or why it did not. */
export type Attached = { path: string } | { warn: string };

/** The clipboard image lands as one file in dir, or the reason it did not. */
export async function pasteImage(dir: string): Promise<Attached> {
  fs.mkdirSync(dir, { recursive: true });
  const file = reserve(dir);
  const warn = await fill(file);
  if (warn !== undefined) {
    fs.rmSync(file, { force: true });
    return { warn };
  }
  return { path: file };
}

/** Whether the text reached the clipboard, or why it did not. */
export type Copied = { ok: true } | { warn: string };

/** The text becomes the clipboard content, or the reason it did not. */
export async function copyText(text: string): Promise<Copied> {
  if (process.platform === "darwin") {
    const done = await feed("pbcopy", [], text);
    return done ? { ok: true } : { warn: "could not copy: pbcopy failed" };
  }
  if (process.platform === "linux") {
    const writers: [string, string[]][] = [
      ["wl-copy", []],
      ["xclip", ["-selection", "clipboard"]],
    ];
    for (const [cmd, args] of writers) {
      if (await feed(cmd, args, text)) return { ok: true };
    }
    return { warn: "could not copy: install wl-copy or xclip" };
  }
  return { warn: `no clipboard copy support on ${process.platform}` };
}

/** xclip forks and its background child keeps the inherited streams open, so the exit decides. */
function feed(cmd: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}

/** Claims the next paste-<n>.png exclusively, so two viewers never share a file. */
export function reserve(dir: string): string {
  for (let n = 1; ; n += 1) {
    const file = path.join(dir, `paste-${n}.png`);
    try {
      fs.writeFileSync(file, "", { flag: "wx" });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function fill(file: string): Promise<string | undefined> {
  if (process.platform === "darwin") return mac(file);
  if (process.platform === "linux") return linux(file);
  return Promise.resolve(`no clipboard image support on ${process.platform}`);
}

function mac(file: string): Promise<string | undefined> {
  const quoted = file.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const script = [
    "set d to (the clipboard as «class PNGf»)",
    `set f to open for access POSIX file "${quoted}" with write permission`,
    "write d to f",
    "close access f",
  ].join("\n");
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], (error) => {
      resolve(error === null ? undefined : "no image in the clipboard");
    });
  });
}

async function linux(file: string): Promise<string | undefined> {
  const readers: [string, string[]][] = [
    ["wl-paste", ["--type", "image/png"]],
    ["xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]],
  ];
  for (const [cmd, args] of readers) {
    const image = await grab(cmd, args);
    if (image !== undefined && image.length > 0) {
      fs.writeFileSync(file, image);
      return undefined;
    }
  }
  return "no image in the clipboard";
}

function grab(cmd: string, args: string[]): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "buffer", maxBuffer: ROOM }, (error, stdout) => {
      resolve(error === null ? stdout : undefined);
    });
  });
}
