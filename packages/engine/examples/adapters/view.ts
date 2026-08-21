import readline from "node:readline";
import type { z } from "zod";
import { adapter, Channel, issuesOf } from "penguin";

type Message = { text: string };

type Ask = {
  (question: string): Promise<string>;
  <Shape extends z.ZodType>(question: string, shape: Shape): Promise<z.infer<Shape>>;
};

export type View = {
  show(text: string): Promise<void>;
  ask: Ask;
  listen(): AsyncIterable<Message>;
  scope(name: string): View;
};

type Pending = {
  prompt: string;
  shape: z.ZodType | undefined;
  resolve: (value: unknown) => void;
};

/** A person types text. JSON is how they type a number, list, or object. */
function candidates(raw: string): unknown[] {
  const list: unknown[] = [raw];
  try {
    list.push(JSON.parse(raw));
  } catch {
    // not JSON, the raw text stands alone
  }
  return list;
}

export function createTerminal(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): View {
  const asks: Pending[] = [];
  const listeners = new Set<Channel<Message>>();
  let reader: readline.Interface | undefined;

  function ensure(): void {
    if (reader !== undefined) return;
    reader = readline.createInterface({ input, output, terminal: false });
    reader.on("line", onLine);
  }

  /** stdin is held only while something wants it, so a finished run can exit. */
  function release(): void {
    if (asks.length > 0 || listeners.size > 0) return;
    reader?.close();
    reader = undefined;
  }

  function prompt(pending: Pending): void {
    output.write(`\n? ${pending.prompt}\n> `);
  }

  function next(): void {
    const pending = asks[0];
    if (pending !== undefined) prompt(pending);
    else release();
  }

  function onLine(raw: string): void {
    const text = raw.trim();
    const pending = asks[0];
    if (pending === undefined) {
      if (text === "") return;
      for (const channel of listeners) channel.push({ text });
      return;
    }
    if (pending.shape === undefined) {
      asks.shift();
      pending.resolve(text);
      next();
      return;
    }
    let problem = "";
    for (const candidate of candidates(text)) {
      const checked = pending.shape.safeParse(candidate);
      if (checked.success) {
        asks.shift();
        pending.resolve(checked.data);
        next();
        return;
      }
      if (problem === "") problem = issuesOf(checked.error);
    }
    output.write(`that answer does not fit: ${problem}\n> `);
  }

  const asked = (question: string, shape: z.ZodType | undefined): Promise<unknown> =>
    new Promise((resolve) => {
      const pending: Pending = { prompt: question, shape, resolve };
      asks.push(pending);
      ensure();
      if (asks[0] === pending) prompt(pending);
    });

  function listen(): AsyncIterable<Message> {
    const channel = new Channel<Message>();
    listeners.add(channel);
    ensure();
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<Message> => {
        const inner = channel[Symbol.asyncIterator]();
        return {
          next: () => inner.next(),
          return: (): Promise<IteratorResult<Message>> => {
            listeners.delete(channel);
            channel.end();
            release();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  function scoped(path: string[]): View {
    const label = (text: string): string => `[${path.join("/")}] ${text}`;
    return {
      show: (text) => api.show(label(text)),
      ask: ((question: string, shape?: z.ZodType) => asked(label(question), shape)) as Ask,
      listen,
      scope: (name) => scoped([...path, name]),
    };
  }

  const api: View = {
    async show(text: string): Promise<void> {
      output.write(`${text}\n`);
    },
    ask: ((question: string, shape?: z.ZodType) => asked(question, shape)) as Ask,
    listen,
    scope: (name) => scoped([name]),
  };
  return api;
}

export default adapter({
  role: "view",
  name: "terminal",
  description: "shows the run on stdout, asks questions and listens for messages on stdin",
  build: () => createTerminal(process.stdin, process.stdout),
});
