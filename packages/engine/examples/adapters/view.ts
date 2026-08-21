import readline from "node:readline";
import { z } from "zod";
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

type Choice = { label: string; value: unknown };

type Menu = { choices: Choice[]; other: boolean };

type Pending = {
  prompt: string;
  shape: z.ZodType | undefined;
  menu: Menu | undefined;
  entering: boolean;
  resolve: (value: unknown) => void;
};

/** The choices a shape names: booleans, enums, literals, and unions of those with free text. */
function menuOf(shape: z.ZodType): Menu | undefined {
  try {
    return fromSchema(z.toJSONSchema(shape) as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

function fromSchema(schema: Record<string, unknown>): Menu | undefined {
  if (schema["type"] === "boolean") {
    return {
      choices: [
        { label: "yes", value: true },
        { label: "no", value: false },
      ],
      other: false,
    };
  }
  const named = schema["enum"] ?? (schema["const"] === undefined ? undefined : [schema["const"]]);
  if (Array.isArray(named)) {
    return { choices: named.map((value) => ({ label: String(value), value })), other: false };
  }
  if (Array.isArray(schema["anyOf"])) {
    const choices: Choice[] = [];
    let other = false;
    for (const member of schema["anyOf"] as Record<string, unknown>[]) {
      const sub = fromSchema(member);
      if (sub !== undefined) {
        choices.push(...sub.choices);
        other = other || sub.other;
      } else if (member["type"] === "string") {
        other = true;
      } else {
        return undefined;
      }
    }
    return choices.length === 0 ? undefined : { choices, other };
  }
  return undefined;
}

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
  let keysEmitted = false;

  const rawInput = input as NodeJS.ReadableStream & {
    isTTY?: boolean;
    setRawMode?(on: boolean): void;
  };
  const setRaw = rawInput.isTTY === true ? rawInput.setRawMode?.bind(rawInput) : undefined;

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

  function present(pending: Pending): void {
    const menu = pending.menu;
    if (menu !== undefined && !pending.entering && setRaw !== undefined) {
      startMenu(pending, menu, setRaw);
      return;
    }
    ensure();
    if (pending.entering) {
      output.write("> ");
      return;
    }
    if (menu === undefined) {
      output.write(`\n? ${pending.prompt}\n> `);
      return;
    }
    output.write(`\n? ${pending.prompt}\n`);
    menu.choices.forEach((choice, at) => output.write(`  ${at + 1}. ${choice.label}\n`));
    if (menu.other) output.write("  or type an answer\n");
    output.write("> ");
  }

  /** An arrow-key menu owns the keys while it is up, so the line reader steps aside. */
  function startMenu(pending: Pending, menu: Menu, raw: (on: boolean) => void): void {
    reader?.close();
    reader = undefined;
    if (!keysEmitted) {
      readline.emitKeypressEvents(input);
      keysEmitted = true;
    }
    raw(true);
    const rows = [...menu.choices.map((choice) => choice.label), ...(menu.other ? ["other…"] : [])];
    let index = 0;
    output.write(`\n? ${pending.prompt}\n`);
    const draw = (redraw: boolean): void => {
      if (redraw) output.write(`\x1b[${rows.length}A`);
      rows.forEach((label, at) => output.write(`\x1b[2K${at === index ? "❯" : " "} ${label}\n`));
    };
    draw(false);
    const finish = (): void => {
      raw(false);
      input.removeListener("keypress", onKey);
    };
    const onKey = (
      _text: string | undefined,
      key: { name?: string; ctrl?: boolean } | undefined,
    ): void => {
      if (key === undefined) return;
      if (key.ctrl === true && key.name === "c") {
        finish();
        output.write("\n");
        process.kill(process.pid, "SIGINT");
        return;
      }
      if (key.name === "up") {
        index = (index + rows.length - 1) % rows.length;
        draw(true);
        return;
      }
      if (key.name === "down") {
        index = (index + 1) % rows.length;
        draw(true);
        return;
      }
      if (key.name !== "return") return;
      finish();
      const choice = menu.choices[index];
      if (choice === undefined) {
        pending.entering = true;
        present(pending);
        return;
      }
      asks.shift();
      settle(pending, choice.value);
      next();
    };
    input.on("keypress", onKey);
  }

  function settle(pending: Pending, value: unknown): void {
    if (pending.shape === undefined) {
      pending.resolve(value);
      return;
    }
    const checked = pending.shape.safeParse(value);
    pending.resolve(checked.success ? checked.data : value);
  }

  function next(): void {
    const pending = asks[0];
    if (pending !== undefined) {
      present(pending);
      return;
    }
    if (listeners.size > 0) {
      ensure();
      return;
    }
    release();
  }

  function onLine(raw: string): void {
    const text = raw.trim();
    const pending = asks[0];
    if (pending === undefined) {
      if (text === "") return;
      for (const channel of listeners) channel.push({ text });
      return;
    }
    const menu = pending.menu;
    if (menu !== undefined && !pending.entering) {
      const number = Number(text);
      const choice = menu.choices[number - 1] ?? menu.choices.find((one) => one.label === text);
      if (choice !== undefined) {
        asks.shift();
        settle(pending, choice.value);
        next();
        return;
      }
      if (!menu.other) {
        output.write("that answer does not fit: pick an option\n> ");
        return;
      }
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
      const pending: Pending = {
        prompt: question,
        shape,
        menu: shape === undefined ? undefined : menuOf(shape),
        entering: false,
        resolve,
      };
      asks.push(pending);
      if (asks[0] === pending) present(pending);
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
  description: "shows the run on stdout, asks with menus or text on stdin, and listens for messages",
  build: () => createTerminal(process.stdin, process.stdout),
});
