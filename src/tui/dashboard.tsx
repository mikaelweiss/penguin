import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import { CopyList, useCopy } from "./input.tsx";
import { Launcher } from "./launcher.tsx";
import { machine, machineLine, type Machine, strained } from "./memory.ts";
import type { Attention } from "./projection.ts";
import { cut } from "./text.ts";
import { glyph, ink, stateColor } from "./theme.ts";
import { age, Feed, type RunRow, runRows, stateOf } from "./watch.ts";

const RESCAN = 2000;
const SPIN = 200;
const keysLine = (showDone: boolean): string =>
  `  arrows or hjkl move, enter opens, y copies the directory, n starts a workflow, d ${showDone ? "hides" : "shows"} done, q quits`;

export type Open = { name: string; node?: string; agent?: string };

type Need = { run: string; item: Attention };

type Line = { kind: "run"; row: RunRow } | { kind: "need"; need: Need };

/** The live runs, the done ones when revealed, and everything that waits on the user. */
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
  const [showDone, setShowDone] = useState(false);
  const [host, setHost] = useState<Machine | undefined>(undefined);
  const [launching, setLaunching] = useState(false);
  const [note, setNote] = useState("");
  const copying = useCopy(setNote);

  const live = rows.filter((row) => row.live);
  const done = rows.filter((row) => !row.live);
  const shown = showDone ? [...live, ...done] : live;

  useEffect(() => {
    const scan = (): void => {
      const found = runRows();
      setRows((was) => (same(was, found) ? was : found));
      void machine().then(setHost);
    };
    scan();
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
    const wanted = new Set(shown.map((row) => row.name));
    for (const [name, feed] of feeds.current) {
      if (wanted.has(name)) continue;
      feed.stop();
      feeds.current.delete(name);
    }
    for (const row of shown) {
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
  }, [rows, showDone]);

  const needs: Need[] = [];
  for (const row of live) {
    const feed = feeds.current.get(row.name);
    if (feed === undefined) continue;
    for (const item of feed.projection.attention()) needs.push({ run: row.name, item });
  }
  const lines: Line[] = [
    ...shown.map((row) => ({ kind: "run" as const, row })),
    ...needs.map((need) => ({ kind: "need" as const, need })),
  ];
  const at = Math.max(0, Math.min(lines.length - 1, cursor));

  /** A run line answers for its whole tree, a needs-you line for the node that waits. */
  const dirsOf = (line: Line): string[] => {
    if (line.kind === "run") {
      const feed = feeds.current.get(line.row.name);
      return feed === undefined ? [line.row.cwd] : feed.projection.directories("root");
    }
    const feed = feeds.current.get(line.need.run);
    return feed === undefined ? [] : feed.projection.directories(line.need.item.node);
  };

  const move = (to: number): void => {
    setCursor(to);
    setNote("");
  };

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    if (launching) return;
    if (key.ctrl && key.name === "c") return onExit();
    if (copying.isOpen()) return copying.key(key);
    if (key.name === "q") return onExit();
    if (key.name === "n") return setLaunching(true);
    if (key.name === "up" || key.name === "k") return move(Math.max(0, at - 1));
    if (key.name === "down" || key.name === "j") return move(Math.min(lines.length - 1, at + 1));
    if (key.name === "left" || key.name === "h") return move(0);
    if (key.name === "right" || key.name === "l") return move(shown.length);
    if (key.name === "d") {
      move(
        showDone
          ? afterHide(at, live.length, done.length, needs.length)
          : afterReveal(at, live.length, done.length, needs.length),
      );
      return setShowDone(!showDone);
    }
    const line = lines[at];
    if (line === undefined) return;
    if (key.name === "return" || key.name === "enter") {
      if (line.kind === "run") return onOpen({ name: line.row.name });
      return onOpen({ name: line.need.run, node: line.need.item.node });
    }
    if (key.name === "y") return copying.start(dirsOf(line));
  });

  if (launching) {
    return (
      <Launcher
        onClose={() => setLaunching(false)}
        onStarted={(started) => {
          setLaunching(false);
          onOpen({ name: started.name, agent: started.agent });
        }}
      />
    );
  }

  const now = Date.now();
  return (
    <box style={{ flexDirection: "column", width: size.width, height: size.height }}>
      <box style={{ flexDirection: "column", flexGrow: 1, border: ["bottom"], borderColor: ink.border }}>
        <Header host={host} width={size.width} />
        {live.length === 0 ? <text fg={ink.faint}>{"  no live run. pn run <workflow> starts one"}</text> : null}
        {live.map((row, index) => (
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
        {showDone ? <text fg={ink.dim}>{" done"}</text> : null}
        {showDone && done.length === 0 ? <text fg={ink.faint}>{"  no done run yet"}</text> : null}
        {showDone
          ? done.map((row, index) => (
              <RunLine
                key={row.name}
                row={row}
                feed={feeds.current.get(row.name)}
                selected={live.length + index === at}
                frame={frame}
                now={now}
                width={size.width}
              />
            ))
          : null}
      </box>
      <box style={{ flexDirection: "column", flexShrink: 0 }}>
        <text fg={ink.dim}>{" needs you"}</text>
        {needs.length === 0 ? <text fg={ink.faint}>{"  nothing waits on you"}</text> : null}
        {needs.map((need, index) => (
          <NeedLine
            key={`${need.run}:${keyOf(need.item)}`}
            need={need}
            selected={shown.length + index === at}
            width={size.width}
          />
        ))}
        {copying.isOpen() ? (
          <CopyList dirs={copying.dirs} cursor={copying.cursor} width={size.width} />
        ) : (
          <text fg={ink.faint}>{cut(note === "" ? keysLine(showDone) : note, size.width)}</text>
        )}
      </box>
    </box>
  );
}

/** The section title, and what the machine has left on the right of the same line. */
function Header({ host, width }: { host: Machine | undefined; width: number }): ReactNode {
  const title = " runs";
  const readout = host === undefined ? "" : machineLine(host);
  const gap = width - title.length - readout.length - 1;
  if (readout === "" || gap < 2) return <text fg={ink.dim}>{title}</text>;
  return (
    <text>
      <span fg={ink.dim}>{`${title}${" ".repeat(gap)}`}</span>
      <span fg={host !== undefined && strained(host) ? ink.warn : ink.faint}>{readout}</span>
    </text>
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

function afterReveal(at: number, live: number, done: number, needs: number): number {
  if (needs === 0 || at < live) return at;
  return at + done;
}

function afterHide(at: number, live: number, done: number, needs: number): number {
  if (at < live) return at;
  const last = Math.max(0, live + needs - 1);
  return Math.min(at >= live + done ? at - done : live, last);
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
