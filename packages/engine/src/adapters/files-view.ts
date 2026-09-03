import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { adapter } from "../core/adapter.ts";
import { Channel } from "../core/channel.ts";
import { issuesOf } from "../core/errors.ts";
import { candidates, type Ask, type AskOptions, type Message, type View } from "../core/view.ts";

type Pending = {
  shape: z.ZodType | undefined;
  resolve: (value: unknown) => void;
};

/** What the inbox holds when the view opens was answered by an earlier segment of the run. */
function sizeOf(file: string): number {
  try {
    return fs.readFileSync(file, "utf8").length;
  } catch {
    return 0;
  }
}

/**
 * The headless view. Shows land in run.jsonl through the trace, answers and
 * messages arrive as lines a frontend appends to inbox.jsonl: {"answer": ...}
 * settles the oldest pending ask, {"message": "..."} reaches every listener.
 */
export function createFilesView(dir: string): View {
  const runFile = path.join(dir, "run.jsonl");
  const inbox = path.join(dir, "inbox.jsonl");
  const asks: Pending[] = [];
  const listeners = new Set<Channel<Message>>();
  let offset = sizeOf(inbox);
  let watching = false;

  const note = (entry: Record<string, unknown>): void => {
    fs.appendFileSync(runFile, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  };

  function ensure(): void {
    if (watching) return;
    watching = true;
    if (!fs.existsSync(inbox)) fs.writeFileSync(inbox, "");
    fs.watchFile(inbox, { interval: 100 }, drain);
    drain();
  }

  /** The inbox is watched only while something waits on it, so a finished run can exit. */
  function release(): void {
    if (asks.length > 0 || listeners.size > 0) return;
    watching = false;
    fs.unwatchFile(inbox, drain);
  }

  function drain(): void {
    if (!fs.existsSync(inbox)) return;
    const text = fs.readFileSync(inbox, "utf8");
    const fresh = text.slice(offset);
    offset = text.length;
    for (const line of fresh.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if ("answer" in parsed) answer(parsed["answer"]);
      else if (typeof parsed["message"] === "string") {
        for (const channel of listeners) channel.push({ text: parsed["message"] });
      }
    }
  }

  function answer(value: unknown): void {
    const pending = asks[0];
    if (pending === undefined) return;
    if (pending.shape === undefined) {
      asks.shift();
      pending.resolve(typeof value === "string" ? value : JSON.stringify(value));
      release();
      return;
    }
    let problem = "";
    for (const candidate of candidates(value)) {
      const checked = pending.shape.safeParse(candidate);
      if (checked.success) {
        asks.shift();
        pending.resolve(checked.data);
        release();
        return;
      }
      if (problem === "") problem = issuesOf(checked.error);
    }
    note({ rejected: value, problem });
  }

  const asked = (shape: z.ZodType | undefined, options?: AskOptions): Promise<unknown> =>
    new Promise((resolve) => {
      const pending: Pending = { shape, resolve };
      asks.push(pending);
      ensure();
      // A dead premise pulls the question out of the queue, so the next answer
      // lands on a live question and never on this one.
      options?.until.then(
        (reason) => {
          const at = asks.indexOf(pending);
          if (at === -1) return;
          asks.splice(at, 1);
          release();
          note({ withdrawn: reason });
          resolve({ withdrawn: true, reason });
        },
        () => {},
      );
    });

  function listen(): AsyncIterable<Message> {
    const channel = new Channel<Message>();
    listeners.add(channel);
    if (listeners.size === 1) note({ listening: true });
    ensure();
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<Message> => {
        const inner = channel[Symbol.asyncIterator]();
        return {
          next: () => inner.next(),
          return: (): Promise<IteratorResult<Message>> => {
            listeners.delete(channel);
            channel.end();
            if (listeners.size === 0) note({ listening: false });
            release();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  return {
    async show(): Promise<void> {
      // The trace records the call; nothing else to do.
    },
    async status(): Promise<void> {
      // The trace records the call; nothing else to do.
    },
    async act(): Promise<void> {
      // The trace records the call; nothing else to do.
    },
    async open(url: string): Promise<void> {
      note({ open: url });
    },
    ask: ((_question: string, shape?: z.ZodType, options?: AskOptions) =>
      asked(shape, options)) as Ask,
    listen,
  };
}

export default adapter({
  role: "view",
  name: "files",
  description: "records the run to its file and takes answers and messages from the run's inbox",
  build: (host) => createFilesView(host.run.dir),
});
