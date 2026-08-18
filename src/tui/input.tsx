import type { KeyEvent } from "@opentui/core";
import { type ReactNode, useReducer, useRef } from "react";
import { copyText } from "../clipboard.ts";
import type { Editor } from "./editor.ts";
import { cut } from "./text.ts";
import { ink } from "./theme.ts";

export type Choice = { label: string; note?: string };

/** The line the user types into, with what it sends named in front of it. */
export function InputBar({
  editor,
  prompt,
  hint,
  width,
}: {
  editor: Editor;
  prompt: string;
  hint: string;
  width: number;
}): ReactNode {
  const { text, cursor } = editor.shown;
  const before = text.slice(0, cursor);
  const under = text.slice(cursor, cursor + 1);
  const after = text.slice(cursor + 1);
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <text>
        <span fg={ink.accent}>{`${prompt} `}</span>
        <span fg={ink.text}>{before}</span>
        <span fg={ink.cursor} bg={ink.cursorBack}>
          {under === "" ? " " : under}
        </span>
        <span fg={ink.text}>{after}</span>
      </text>
      <text fg={ink.faint}>{cut(hint, width)}</text>
    </box>
  );
}

/** A list the user moves through: one choice, or many with checkboxes. */
export function Choices({
  title,
  notes,
  choices,
  cursor,
  chosen,
  many,
  keys,
  width,
}: {
  title: string;
  notes?: string[];
  choices: Choice[];
  cursor: number;
  chosen: number[];
  many: boolean;
  keys?: string;
  width: number;
}): ReactNode {
  const help = keys ?? (many ? "arrows move, space toggles, enter confirms" : "arrows move, enter confirms");
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <text fg={ink.warn}>{cut(title, width)}</text>
      {(notes ?? []).map((note) => (
        <text key={note} fg={ink.dim}>{cut(`  ${note}`, width)}</text>
      ))}
      {choices.map((choice, index) => {
        const here = index === cursor;
        const box = many ? (chosen.includes(index) ? "[x]" : "[ ]") : here ? "(o)" : "( )";
        const note = choice.note === undefined ? "" : `  ${choice.note}`;
        return (
          <text key={choice.label} fg={here ? ink.text : ink.dim}>
            {cut(`${here ? ">" : " "} ${box} ${choice.label}${note}`, width)}
          </text>
        );
      })}
      <text fg={ink.faint}>{cut(`  ${help}`, width)}</text>
    </box>
  );
}

export type FormField = { name: string; label: string; secret: boolean };

/** One credential field at a time. A secret value shows as stars, never as itself. */
export function Fields({
  title,
  notes,
  fields,
  at,
  values,
  buffer,
  width,
}: {
  title: string;
  notes: string[];
  fields: FormField[];
  at: number;
  values: Record<string, string>;
  buffer: string;
  width: number;
}): ReactNode {
  const field = fields[at];
  if (field === undefined) return null;
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <text fg={ink.warn}>{cut(title, width)}</text>
      {notes.map((note) => (
        <text key={note} fg={ink.dim}>{cut(`  ${note}`, width)}</text>
      ))}
      {fields.slice(0, at).map((one) => (
        <text key={one.name} fg={ink.dim}>
          {cut(`  ${one.label}: ${mask(one, values[one.name] ?? "")}`, width)}
        </text>
      ))}
      <text fg={ink.text}>{cut(`  ${field.label}`, width)}</text>
      <text>
        <span fg={ink.accent}>{"> "}</span>
        <span fg={ink.text}>{mask(field, buffer)}</span>
        <span fg={ink.cursor} bg={ink.cursorBack}>
          {" "}
        </span>
      </text>
      <text fg={ink.faint}>{cut("  enter confirms, esc clears the line", width)}</text>
    </box>
  );
}

function mask(field: FormField, text: string): string {
  return field.secret ? "*".repeat(text.length) : text;
}

export type Copying = {
  dirs: string[];
  cursor: number;
  isOpen(): boolean;
  start(dirs: string[]): void;
  key(event: KeyEvent): void;
};

type Copy = { dirs: string[]; cursor: number };

const CLOSED: Copy = { dirs: [], cursor: 0 };

/**
 * The `y` key on any screen. One directory copies at once, several open the picker.
 * A ref holds the picker: a terminal delivers several keys with no render between them.
 */
export function useCopy(report: (note: string) => void): Copying {
  const held = useRef<Copy>(CLOSED);
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const set = (next: Copy): void => {
    held.current = next;
    bump();
  };
  const copy = async (target: string): Promise<void> => {
    const done = await copyText(target);
    report("ok" in done ? `copied ${target}` : done.warn);
  };
  return {
    dirs: held.current.dirs,
    cursor: held.current.cursor,
    isOpen: () => held.current.dirs.length > 0,
    start(dirs: string[]): void {
      const only = dirs[0];
      if (only === undefined) return;
      if (dirs.length === 1) return void copy(only);
      set({ dirs, cursor: 0 });
    },
    /** A terminal folds an escape that precedes another key into a modifier, and neither key acts. */
    key(event: KeyEvent): void {
      if (event.meta || event.ctrl) return;
      const open = held.current;
      const step = (delta: number): void => {
        set({ ...open, cursor: (open.cursor + open.dirs.length + delta) % open.dirs.length });
      };
      if (event.name === "up" || event.name === "k") return step(-1);
      if (event.name === "down" || event.name === "j") return step(1);
      if (event.name === "escape") return set(CLOSED);
      if (event.name === "return" || event.name === "enter") {
        const target = open.dirs[open.cursor];
        set(CLOSED);
        if (target !== undefined) void copy(target);
      }
    },
  };
}

/** The directory picker, the same on every screen. */
export function CopyList({
  dirs,
  cursor,
  width,
}: {
  dirs: string[];
  cursor: number;
  width: number;
}): ReactNode {
  return (
    <Choices
      title="copy which directory?"
      choices={dirs.map((one) => ({ label: one }))}
      cursor={cursor}
      chosen={[]}
      many={false}
      keys="arrows move, enter copies, esc cancels"
      width={width}
    />
  );
}
