import { type BoxRenderable, RGBA, TextAttributes } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { type ReactNode, useEffect, useReducer, useRef } from "react";
import type { IBufferCell, IBufferLine, Shell } from "../../machine/shell.ts";
import { cut, tail } from "../text.ts";
import { ink } from "../theme.ts";

const FRAME = 33;

export const MIN_ROWS = 3;
export const PANE_ROWS = 12;

type Run = { text: string; fg: RGBA | string; bg?: RGBA; attributes: number };

/** The shell's screen under the input bar: its rows, the divider that drags, and its own keys. */
export function ShellPane({
  shell,
  path,
  rows,
  width,
  focused,
  onFocus,
  onGrab,
  onEnd,
}: {
  shell: Shell | undefined;
  path?: string;
  rows: number;
  width: number;
  focused: boolean;
  onFocus(): void;
  onGrab(): void;
  onEnd(): void;
}): ReactNode {
  const frame = useFrames(shell);
  const renderer = useRenderer();
  const screen = useRef<BoxRenderable | null>(null);

  useEffect(() => {
    shell?.resize(Math.max(1, width), Math.max(1, rows));
  }, [shell, width, rows]);

  useEffect(() => {
    const box = screen.current;
    if (!focused || shell === undefined || box === null) return;
    const at = shell.screen().cursor;
    renderer.setCursorPosition(box.x + at.x, box.y + at.y, at.visible);
    return () => renderer.setCursorPosition(0, 0, false);
  }, [focused, shell, frame, renderer]);

  useEffect(() => {
    if (shell === undefined || shell.alive) return;
    onEnd();
  }, [shell, frame]);

  const lines = shell === undefined ? [] : shell.screen().lines;
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <text
        fg={focused ? ink.accent : ink.border}
        selectable={false}
        onMouseDown={() => {
          onFocus();
          onGrab();
        }}
      >
        {divider(path, width, focused)}
      </text>
      <box
        ref={screen}
        style={{ flexDirection: "column", flexShrink: 0, height: rows, overflow: "hidden" }}
        onMouseDown={onFocus}
        onMouseScroll={(event) => shell?.scroll(event.scroll?.direction === "up" ? -3 : 3)}
      >
        {shell === undefined ? (
          <text fg={ink.faint}>{cut(` ${absent(path)}`, width)}</text>
        ) : (
          lines.map((line, row) => (
            <text key={row}>
              {runs(line, width).map((one, index) => (
                <span
                  key={index}
                  fg={one.fg}
                  {...(one.bg === undefined ? {} : { bg: one.bg })}
                  attributes={one.attributes}
                >
                  {one.text}
                </span>
              ))}
            </text>
          ))
        )}
      </box>
    </box>
  );
}

function absent(path: string | undefined): string {
  if (path === undefined) return "this node covers several directories: pick one";
  return `${path} is gone, so no shell opens there`;
}

function divider(path: string | undefined, width: number, focused: boolean): string {
  const keys = focused ? "  ctrl-/ closes " : " ";
  const name = tail(path ?? "no directory", Math.max(4, width - keys.length - 3));
  const line = `─ ${name}${keys}`;
  return cut(line.padEnd(width, "─"), width);
}

/** A repaint per frame at most, however much the shell prints. */
function useFrames(shell: Shell | undefined): number {
  const [frame, tick] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (shell === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = shell.onChange(() => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        tick();
      }, FRAME);
      timer.unref?.();
    });
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [shell]);
  return frame;
}

/** One row of the shell's screen as the fewest spans that keep its colors. */
function runs(line: IBufferLine | undefined, width: number): Run[] {
  if (line === undefined) return [{ text: " ".repeat(width), fg: ink.text, attributes: 0 }];
  const out: Run[] = [];
  let last = "";
  for (let x = 0; x < width; ) {
    const cell = line.getCell(x);
    if (cell === undefined) {
      out.push({ text: " ".repeat(width - x), fg: ink.text, attributes: 0 });
      break;
    }
    const size = cell.getWidth();
    if (size === 0) {
      x += 1;
      continue;
    }
    const chars = cell.getChars();
    const attributes = marks(cell);
    const style = `${cell.getFgColorMode()}:${cell.getFgColor()}:${cell.getBgColorMode()}:${cell.getBgColor()}:${attributes}`;
    const text = chars === "" ? " " : chars;
    const open = out[out.length - 1];
    if (open !== undefined && style === last) open.text += text;
    else {
      const fg = color(cell.isFgDefault(), cell.isFgRGB(), cell.getFgColor()) ?? ink.text;
      const bg = color(cell.isBgDefault(), cell.isBgRGB(), cell.getBgColor());
      out.push({ text, fg, ...(bg === undefined ? {} : { bg }), attributes });
    }
    last = style;
    x += size;
  }
  return out;
}

function color(isDefault: boolean, isRGB: boolean, value: number): RGBA | undefined {
  if (isDefault) return undefined;
  if (isRGB) return RGBA.fromInts((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff, 255);
  return RGBA.fromIndex(value);
}

function marks(cell: IBufferCell): number {
  let attributes = TextAttributes.NONE;
  if (cell.isBold()) attributes |= TextAttributes.BOLD;
  if (cell.isDim()) attributes |= TextAttributes.DIM;
  if (cell.isItalic()) attributes |= TextAttributes.ITALIC;
  if (cell.isUnderline()) attributes |= TextAttributes.UNDERLINE;
  if (cell.isBlink()) attributes |= TextAttributes.BLINK;
  if (cell.isInverse()) attributes |= TextAttributes.INVERSE;
  if (cell.isInvisible()) attributes |= TextAttributes.HIDDEN;
  if (cell.isStrikethrough()) attributes |= TextAttributes.STRIKETHROUGH;
  return attributes;
}
