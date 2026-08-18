import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import type { Attention } from "./projection.ts";
import { cut } from "./text.ts";
import { glyph, ink, stateColor } from "./theme.ts";
import { age, Feed, type RunRow, runRows, stateOf } from "./watch.ts";

const RESCAN = 2000;
const SPIN = 200;

export type Open = { name: string; node?: string };

type Need = { run: string; item: Attention };

type Line = { kind: "run"; row: RunRow } | { kind: "need"; need: Need };

/** Every run penguin knows, and everything that waits on the user. */
export function Dashboard({
  onOpen,
  onExit,
}: {
  onOpen(open: Open): void;
  onExit(): void;
}): ReactNode {
  const size = useTerminalDimensions();
  const feeds = useRef(new Map<string, Feed>());
  const [rows, setRows] = useState<RunRow[]>(() => runRows());
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const [cursor, setCursor] = useState(0);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const scan = (): void => {
      const found = runRows();
      setRows((was) => (same(was, found) ? was : found));
    };
    const timer = setInterval(scan, RESCAN);
    timer.unref?.();
    const spin = setInterval(() => setFrame((count) => count + 1), SPIN);
    spin.unref?.();
    const held = feeds.current;
    return () => {
      clearInterval(timer);
      clearInterval(spin);
      for (const feed of held.values()) feed.stop();
      held.clear();
    };
  }, []);

  useEffect(() => {
    const offs: (() => void)[] = [];
    const wanted = new Set(rows.map((row) => row.name));
    for (const [name, feed] of feeds.current) {
      if (wanted.has(name)) continue;
      feed.stop();
      feeds.current.delete(name);
    }
    for (const row of rows) {
      let feed = feeds.current.get(row.name);
      if (feed === undefined) {
        feed = new Feed(row.name, row.dir);
        feed.read();
        feeds.current.set(row.name, feed);
      }
      if (row.live) offs.push(feed.follow(bump));
      else feed.pump();
    }
    bump();
    return () => {
      for (const off of offs) off();
    };
  }, [rows]);

  const needs: Need[] = [];
  for (const row of rows) {
    if (!row.live) continue;
    const feed = feeds.current.get(row.name);
    if (feed === undefined) continue;
    for (const item of feed.projection.attention()) needs.push({ run: row.name, item });
  }
  const lines: Line[] = [
    ...rows.map((row) => ({ kind: "run" as const, row })),
    ...needs.map((need) => ({ kind: "need" as const, need })),
  ];
  const at = Math.max(0, Math.min(lines.length - 1, cursor));

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    if (key.name === "q" || (key.ctrl && key.name === "c")) return onExit();
    if (key.name === "up" || key.name === "k") return setCursor(Math.max(0, at - 1));
    if (key.name === "down" || key.name === "j") return setCursor(Math.min(lines.length - 1, at + 1));
    if (key.name === "left" || key.name === "h") return setCursor(0);
    if (key.name === "right" || key.name === "l") return setCursor(rows.length);
    if (key.name === "return" || key.name === "enter") {
      const line = lines[at];
      if (line === undefined) return;
      if (line.kind === "run") return onOpen({ name: line.row.name });
      return onOpen({ name: line.need.run, node: line.need.item.node });
    }
  });

  const now = Date.now();
  return (
    <box style={{ flexDirection: "column", width: size.width, height: size.height }}>
      <box style={{ flexDirection: "column", flexGrow: 1, border: ["bottom"], borderColor: ink.border }}>
        <text fg={ink.dim}>{" runs"}</text>
        {rows.length === 0 ? <text fg={ink.faint}>{"  no run yet. pn run <workflow> starts one"}</text> : null}
        {rows.map((row, index) => (
          <RunLine
            key={row.name}
            row={row}
            feed={feeds.current.get(row.name)}
            selected={index === at}
            frame={frame}
            now={now}
            width={size.width}
          />
        ))}
      </box>
      <box style={{ flexDirection: "column", flexShrink: 0 }}>
        <text fg={ink.dim}>{" needs you"}</text>
        {needs.length === 0 ? <text fg={ink.faint}>{"  nothing waits on you"}</text> : null}
        {needs.map((need, index) => (
          <NeedLine
            key={`${need.run}:${keyOf(need.item)}`}
            need={need}
            selected={rows.length + index === at}
            width={size.width}
          />
        ))}
        <text fg={ink.faint}>{"  arrows or hjkl move, enter opens, q quits"}</text>
      </box>
    </box>
  );
}

function RunLine({
  row,
  feed,
  selected,
  frame,
  now,
  width,
}: {
  row: RunRow;
  feed: Feed | undefined;
  selected: boolean;
  frame: number;
  now: number;
  width: number;
}): ReactNode {
  const live = feed === undefined ? { state: row.live ? "running" : "done", detail: "" } : stateOf(feed, row.live);
  const mark = glyph(stateGlyph(live.state), frame);
  const detail = live.detail === "" ? "" : `: ${live.detail.split("\n")[0] ?? ""}`;
  const text = `${row.name}  ${row.workflow}  ${live.state}${detail}`;
  return (
    <text>
      <span fg={selected ? ink.accent : ink.faint}>{selected ? " > " : "   "}</span>
      <span fg={stateColor(live.state)}>{`${mark} `}</span>
      <span fg={selected ? ink.text : ink.dim}>{cut(text, Math.max(10, width - 12))}</span>
      <span fg={ink.faint}>{`  ${age(now - row.createdAt)}`}</span>
    </text>
  );
}

function NeedLine({ need, selected, width }: { need: Need; selected: boolean; width: number }): ReactNode {
  const item = need.item;
  const what = item.kind === "gate" ? item.question : `${item.label} needs a credential`;
  const path = item.path.join(" / ");
  return (
    <text>
      <span fg={selected ? ink.accent : ink.faint}>{selected ? " > " : "   "}</span>
      <span fg={selected ? ink.text : ink.dim}>{cut(`${need.run}  ${path}  ${first(what)}`, width - 4)}</span>
    </text>
  );
}

function first(text: string): string {
  return text.split("\n").find((line) => line.trim() !== "") ?? "";
}

function stateGlyph(state: string): "running" | "blocked" | "idle" | "done" | "failed" | "quiet" {
  if (state === "running" || state === "blocked" || state === "idle") return state;
  if (state === "error" || state === "failed") return "failed";
  if (state === "done" || state === "stopped") return "done";
  return "quiet";
}

function keyOf(item: Attention): string {
  return item.kind === "gate" ? `gate:${item.gate ?? item.question}` : `credential:${item.name}`;
}

function same(left: RunRow[], right: RunRow[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const other = right[index];
    return other !== undefined && other.name === row.name && other.live === row.live;
  });
}
