import type { ReactNode } from "react";
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
