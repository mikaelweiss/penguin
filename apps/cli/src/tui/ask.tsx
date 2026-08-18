import { decodePasteBytes, type KeyEvent } from "@opentui/core";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useState } from "react";
import type { Attached } from "./clipboard.ts";
import { Editor } from "./editor.ts";
import { Choices, InputBar } from "./input.tsx";
import { ink } from "./theme.ts";

export type Choice = { label: string; note?: string };

export type AskOptions = {
  notes?: string[];
  attach?: () => Promise<Attached>;
  /** What Ctrl-C does before penguin leaves with 130. */
  interrupt?: () => void;
};

export type Done<T> = (value: T | undefined) => void;

/** One question penguin's own commands ask. The answer replaces the question. */
export async function askText(question: string, options: AskOptions = {}): Promise<string> {
  return show<string>((done) => <Ask question={question} options={options} onDone={done} />, options);
}

export async function pickOne(question: string, choices: Choice[], options: AskOptions = {}): Promise<number> {
  if (choices.length === 0) return 0;
  const picked = await show<number[]>(
    (done) => <Pick question={question} choices={choices} many={false} options={options} onDone={done} />,
    options,
  );
  return picked[0] ?? 0;
}

export async function pickSome(question: string, choices: Choice[], options: AskOptions = {}): Promise<number[]> {
  if (choices.length === 0) return [];
  return show<number[]>(
    (done) => <Pick question={question} choices={choices} many={true} options={options} onDone={done} />,
    options,
  );
}

/** The terminal belongs to the question until it is answered, and never after. */
async function show<T>(view: (done: Done<T>) => ReactNode, options: AskOptions): Promise<T> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "main-screen",
    targetFps: 30,
  });
  const root = createRoot(renderer);
  const taken = await new Promise<T | undefined>((resolve) => {
    let settled = false;
    root.render(
      view((value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      }),
    );
  });
  root.unmount();
  renderer.destroy();
  if (taken !== undefined) return taken;
  options.interrupt?.();
  process.exit(130);
}

export function Ask({
  question,
  options,
  onDone,
}: {
  question: string;
  options: AskOptions;
  onDone: Done<string>;
}): ReactNode {
  const size = useTerminalDimensions();
  const [editor] = useState(() => new Editor());
  const [warn, setWarn] = useState("");
  const [, bump] = useState(0);
  const redraw = (): void => bump((count) => count + 1);

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    if (key.ctrl && key.name === "c") return onDone(undefined);
    if (key.name === "return" || key.name === "enter") return onDone(editor.take());
    if (key.ctrl && key.name === "v") {
      const attach = options.attach;
      if (attach === undefined) return;
      void attach().then((got) => {
        if ("path" in got) editor.insert(got.path);
        else setWarn(got.warn);
        redraw();
      });
      return;
    }
    if (key.ctrl) {
      if (key.name === "a") editor.head();
      else if (key.name === "e") editor.tail();
      else if (key.name === "u") editor.killLeft();
      else if (key.name === "k") editor.killRight();
      else if (key.name === "w") editor.killWord();
      else return;
      return redraw();
    }
    if (key.name === "escape") editor.clear();
    else if (key.name === "backspace") editor.backspace();
    else if (key.name === "delete") editor.delete();
    else if (key.name === "left") editor.left();
    else if (key.name === "right") editor.right();
    else if (key.name === "home") editor.head();
    else if (key.name === "end") editor.tail();
    else {
      const typed = typing(key);
      if (typed === undefined) return;
      editor.insert(typed);
    }
    redraw();
  });

  usePaste((event) => {
    editor.paste(decodePasteBytes(event.bytes));
    redraw();
  });

  const hint = warn === "" ? "enter confirms, esc clears the line" : warn;
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={ink.text}>{question}</text>
      {(options.notes ?? []).map((note) => (
        <text key={note} fg={ink.dim}>{`  ${note}`}</text>
      ))}
      <InputBar editor={editor} prompt=">" hint={hint} focused={true} width={size.width} />
    </box>
  );
}

export function Pick({
  question,
  choices,
  many,
  options,
  onDone,
}: {
  question: string;
  choices: Choice[];
  many: boolean;
  options: AskOptions;
  onDone: Done<number[]>;
}): ReactNode {
  const size = useTerminalDimensions();
  const [cursor, setCursor] = useState(0);
  const [chosen, setChosen] = useState<number[]>(() => (many ? choices.map((_, index) => index) : []));

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    if (key.ctrl && key.name === "c") return onDone(undefined);
    if (key.name === "up" || key.name === "k") return setCursor((cursor + choices.length - 1) % choices.length);
    if (key.name === "down" || key.name === "j") return setCursor((cursor + 1) % choices.length);
    if (key.name === "space" && many) {
      return setChosen((was) =>
        was.includes(cursor) ? was.filter((index) => index !== cursor) : [...was, cursor].sort((a, b) => a - b),
      );
    }
    if (key.name === "return" || key.name === "enter") return onDone(many ? chosen : [cursor]);
  });

  return (
    <Choices
      title={question}
      notes={options.notes ?? []}
      choices={choices}
      cursor={cursor}
      chosen={chosen}
      many={many}
      width={size.width}
    />
  );
}

function typing(key: KeyEvent): string | undefined {
  if (key.ctrl || key.meta) return undefined;
  const sequence = key.sequence;
  if (sequence.length !== 1) return undefined;
  const code = sequence.codePointAt(0) ?? 0;
  if (code < 0x20 || code === 0x7f) return undefined;
  return sequence;
}
