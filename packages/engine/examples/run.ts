// Runs one workflow in the foreground and presents its whole run tree from the
// run files, the same way any frontend does: reading run.jsonl, writing inboxes.
// usage: bun examples/run.ts examples/workflows/commit.ts '{"dir":"."}'
//        bun examples/run.ts --resume <run id>
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { starterCatalog, type Catalog } from "../src/catalog/catalogs.ts";
import { messageOf, RunPaused } from "../src/core/errors.ts";
import { menuOfSchema, type Menu } from "../src/core/view.ts";
import { runDir } from "../src/paths.ts";
import { run, runId } from "../src/run.ts";
import { livePid, runHead } from "../src/trace.ts";

type Start = { id: string; file: string; params: unknown; catalogs: Catalog[]; resume: boolean };

function usage(): never {
  process.stderr.write(
    "usage: bun examples/run.ts <workflow.ts> ['{...params}']\n       bun examples/run.ts --resume <run id>\n",
  );
  process.exit(2);
}

function starting(argv: string[]): Start {
  const [first, second] = argv;
  if (first === undefined) usage();
  if (first !== "--resume") {
    return {
      id: runId(),
      file: first,
      params: second === undefined ? {} : JSON.parse(second),
      catalogs: [starterCatalog()],
      resume: false,
    };
  }
  if (second === undefined) usage();
  const head = runHead(second);
  if (head === undefined) {
    process.stderr.write(`penguin: no run named ${second}\n`);
    process.exit(2);
  }
  return {
    id: second,
    file: head["workflow"] as string,
    params: head["params"],
    catalogs: (head["catalogs"] as Catalog[] | undefined) ?? [starterCatalog()],
    resume: true,
  };
}

const start = starting(process.argv.slice(2));

type Watched = {
  id: string;
  label: string;
  offset: number;
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

/** What the whole tree spent, summed from every run's usage notes. */
const spent = { turns: 0, tokens: 0, usd: 0, priced: false };

const rootId = start.id;
/** A resumed run's story was already told; only what the new process writes prints. */
const told = start.resume ? fs.statSync(path.join(runDir(rootId), "run.jsonl")).size : 0;
runs.set(rootId, { id: rootId, label: "", offset: told, listening: false, done: false });

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
  if (typeof entry["child"] === "string" && typeof entry["workflow"] === "string") {
    if (runs.has(entry["child"])) return;
    const name = path.basename(entry["workflow"]).replace(/\.ts$/, "");
    const label = watched.label === "" ? name : `${watched.label}/${name}`;
    runs.set(entry["child"], {
      id: entry["child"],
      label,
      offset: 0,
      listening: false,
      done: false,
    });
    return;
  }
  if (entry["listening"] === true) watched.listening = true;
  if (entry["listening"] === false) watched.listening = false;
  const usage = entry["usage"];
  if (usage !== null && typeof usage === "object") {
    const counted = usage as Record<string, unknown>;
    const number = (key: string): number =>
      typeof counted[key] === "number" ? (counted[key] as number) : 0;
    spent.turns += 1;
    spent.tokens += number("input") + number("cacheRead") + number("cacheWrite") + number("output");
    if (typeof counted["usd"] === "number") {
      spent.usd += counted["usd"] as number;
      spent.priced = true;
    }
    return;
  }
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
  if (
    entry["call"] === undefined &&
    ("outcome" in entry || "threw" in entry || "paused" in entry || entry["stopped"] === true)
  ) {
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

/** Ctrl-C parks the whole tree where it stands. The root runs in this process, so its note is ours to write. */
function pauseTree(): void {
  for (const watched of runs.values()) {
    if (watched.id === rootId || watched.done) continue;
    const pid = livePid(watched.id);
    if (pid === undefined) continue;
    try {
      process.kill(-pid, "SIGINT");
    } catch {
      // already gone
    }
  }
  const note = JSON.stringify({ at: new Date().toISOString(), paused: { by: "user" } });
  fs.appendFileSync(path.join(runDir(rootId), "run.jsonl"), `${note}\n`);
}

process.on("SIGINT", () => {
  pauseTree();
  out.write(`\npaused. resume with: bun examples/run.ts --resume ${rootId}\n`);
  process.exit(130);
});

const ticker = setInterval(drain, 100);

try {
  const result = await run(start.file, start.params, {
    id: rootId,
    catalogs: start.catalogs,
    resume: start.resume,
  });
  drain();
  out.write(`\n${JSON.stringify(result, null, 2)}\n`);
  if (spent.turns > 0) {
    const dollars = spent.priced ? `, $${spent.usd.toFixed(2)}` : "";
    out.write(`\nspent: ${spent.turns} turns, ${spent.tokens.toLocaleString()} tokens${dollars}\n`);
  }
  process.exit(0);
} catch (error) {
  drain();
  if (error instanceof RunPaused) {
    out.write(`\npaused: ${error.message}\nresume with: bun examples/run.ts --resume ${rootId}\n`);
    process.exit(130);
  }
  process.stderr.write(`penguin: ${messageOf(error)}\n`);
  process.exit(1);
} finally {
  clearInterval(ticker);
  reader.close();
}
