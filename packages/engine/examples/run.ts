// Runs one workflow in the foreground and presents its whole run tree from the
// run files, the same way any frontend does: reading run.jsonl, writing inboxes.
// usage: bun examples/run.ts examples/workflows/commit.ts '{"dir":"."}'
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { starterCatalog } from "../src/catalog/catalogs.ts";
import { messageOf } from "../src/core/errors.ts";
import { menuOfSchema, type Menu } from "../src/core/view.ts";
import { runDir } from "../src/paths.ts";
import { run, runId } from "../src/run.ts";

const [file, json] = process.argv.slice(2);
if (file === undefined) {
  process.stderr.write("usage: bun examples/run.ts <workflow.ts> ['{...params}']\n");
  process.exit(2);
}

type Watched = {
  id: string;
  label: string;
  offset: number;
  pid: number | undefined;
  listening: boolean;
  done: boolean;
};

type Prompt = {
  run: Watched;
  entry: string;
  question: string;
  menu: Menu | undefined;
  entering: boolean;
};

const runs = new Map<string, Watched>();
const prompts: Prompt[] = [];
let presented: Prompt | undefined;

const rootId = runId();
runs.set(rootId, { id: rootId, label: "", offset: 0, pid: undefined, listening: false, done: false });

const out = process.stdout;
const reader = readline.createInterface({ input: process.stdin, output: out, terminal: false });
reader.on("line", onLine);

function inboxOf(id: string): string {
  return path.join(runDir(id), "inbox.jsonl");
}

function send(id: string, line: Record<string, unknown>): void {
  fs.appendFileSync(inboxOf(id), `${JSON.stringify(line)}\n`);
}

function prefix(watched: Watched): string {
  return watched.label === "" ? "" : `[${watched.label}] `;
}

function drain(): void {
  for (const watched of [...runs.values()]) {
    const target = path.join(runDir(watched.id), "run.jsonl");
    if (!fs.existsSync(target)) continue;
    const text = fs.readFileSync(target, "utf8");
    const fresh = text.slice(watched.offset);
    watched.offset = text.length;
    for (const line of fresh.split("\n")) {
      if (line.trim() === "") continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      consume(watched, entry);
    }
  }
  if (presented === undefined) present();
}

function consume(watched: Watched, entry: Record<string, unknown>): void {
  if (typeof entry["pid"] === "number") watched.pid = entry["pid"];
  if (typeof entry["child"] === "string" && typeof entry["workflow"] === "string") {
    const name = path.basename(entry["workflow"]).replace(/\.ts$/, "");
    const label = watched.label === "" ? name : `${watched.label}/${name}`;
    runs.set(entry["child"], {
      id: entry["child"],
      label,
      offset: 0,
      pid: undefined,
      listening: false,
      done: false,
    });
    return;
  }
  if (entry["listening"] === true) watched.listening = true;
  if (entry["listening"] === false) watched.listening = false;
  const args = Array.isArray(entry["args"]) ? (entry["args"] as unknown[]) : [];
  if (entry["call"] === "view.show" && entry["pending"] === true) {
    out.write(`${prefix(watched)}${String(args[0])}\n`);
    return;
  }
  if (entry["call"] === "view.status" && entry["pending"] === true) {
    out.write(`${prefix(watched)}  ${String(args[0])}\n`);
    return;
  }
  if (entry["call"] === "view.act" && entry["pending"] === true) {
    const action = args[0] as { name?: string; status?: string; target?: string } | undefined;
    if (action?.status !== "running") return;
    const acted = action.target === undefined ? "" : `: ${action.target}`;
    out.write(`${prefix(watched)}  ${String(action.name)}${acted}\n`);
    return;
  }
  if (entry["call"] === "view.ask" && entry["pending"] === true && typeof entry["id"] === "string") {
    const schema = args[1] as Record<string, unknown> | undefined;
    prompts.push({
      run: watched,
      entry: entry["id"],
      question: String(args[0]),
      menu: schema === undefined ? undefined : menuOfSchema(schema),
      entering: false,
    });
    return;
  }
  if (entry["call"] === "view.ask" && typeof entry["id"] === "string" && entry["pending"] !== true) {
    // Settled, possibly by another frontend. Drop it from the queue.
    const settled = prompts.findIndex(
      (prompt) => prompt.run === watched && prompt.entry === entry["id"],
    );
    if (settled !== -1) {
      const [gone] = prompts.splice(settled, 1);
      if (presented === gone) presented = undefined;
    }
    return;
  }
  if ("rejected" in entry && presented?.run === watched) {
    out.write(`that answer does not fit: ${String(entry["problem"] ?? "")}\n> `);
    return;
  }
  if (entry["call"] === undefined && ("outcome" in entry || "threw" in entry || entry["stopped"] === true)) {
    watched.done = true;
  }
}

function present(): void {
  const prompt = prompts[0];
  if (prompt === undefined) return;
  presented = prompt;
  const menu = prompt.menu;
  out.write(`\n? ${prefix(prompt.run)}${prompt.question}\n`);
  if (menu === undefined || prompt.entering) {
    out.write("> ");
    return;
  }
  menu.choices.forEach((choice, at) => out.write(`  ${at + 1}. ${choice.label}\n`));
  if (menu.many) out.write("  numbers, comma separated\n");
  if (menu.other) out.write("  or type an answer\n");
  out.write("> ");
}

function onLine(raw: string): void {
  const text = raw.trim();
  const prompt = presented;
  if (prompt === undefined) {
    if (text === "") return;
    for (const watched of runs.values()) {
      if (watched.listening && !watched.done) send(watched.id, { message: text });
    }
    return;
  }
  const menu = prompt.menu;
  if (menu !== undefined && !prompt.entering) {
    const picked = menu.many ? pickMany(menu, text) : pickOne(menu, text);
    if (picked !== undefined) {
      answer(prompt, picked);
      return;
    }
    if (!menu.other) {
      out.write("that answer does not fit: pick an option\n> ");
      return;
    }
  }
  answer(prompt, text);
}

function pickOne(menu: Menu, text: string): { value: unknown } | undefined {
  const number = Number(text);
  const choice = menu.choices[number - 1] ?? menu.choices.find((one) => one.label === text);
  return choice === undefined ? undefined : { value: choice.value };
}

function pickMany(menu: Menu, text: string): { value: unknown } | undefined {
  const parts = text.split(/[\s,]+/).filter((part) => part !== "");
  if (parts.length === 0) return undefined;
  const values: unknown[] = [];
  for (const part of parts) {
    const one = pickOne(menu, part);
    if (one === undefined) return undefined;
    values.push(one.value);
  }
  return { value: values };
}

function answer(prompt: Prompt, value: { value: unknown } | string): void {
  send(prompt.run.id, { answer: typeof value === "string" ? value : value.value });
  const at = prompts.indexOf(prompt);
  if (at !== -1) prompts.splice(at, 1);
  presented = undefined;
  present();
}

function stopTree(): void {
  for (const watched of runs.values()) {
    if (watched.id === rootId || watched.pid === undefined || watched.done) continue;
    try {
      process.kill(-watched.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

process.on("SIGINT", () => {
  stopTree();
  out.write("\n");
  process.exit(130);
});

const ticker = setInterval(drain, 100);

try {
  const result = await run(file, json === undefined ? {} : JSON.parse(json), {
    id: rootId,
    catalogs: [starterCatalog()],
  });
  drain();
  out.write(`\n${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
} catch (error) {
  drain();
  process.stderr.write(`penguin: ${messageOf(error)}\n`);
  process.exit(1);
} finally {
  clearInterval(ticker);
  reader.close();
}
