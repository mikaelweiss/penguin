import type { ReactNode } from "react";
import type { NodeState, Projection } from "@mikaelweiss/penguin-viewer";
import { cut } from "../text.ts";
import { glyph, ink, stateColor } from "../theme.ts";

export type TreeRow = {
  key: string;
  kind: "node" | "session";
  id: string;
  depth: number;
  label: string;
  detail?: string;
  state: NodeState;
  children: boolean;
  open: boolean;
};

export type Selection = { kind: "node" | "session"; id: string };

/** The rows the left pane draws: every open node, each with its sessions under it. */
export function treeRows(projection: Projection, closed: Set<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (id: string, depth: number): void => {
    const node = projection.node(id);
    if (node === undefined) return;
    const open = !closed.has(id);
    rows.push({
      key: `node:${id}`,
      kind: "node",
      id,
      depth,
      label: node.label,
      ...(node.detail === undefined ? {} : { detail: node.detail }),
      state: node.state,
      children: node.children.length > 0 || node.sessions.length > 0,
      open,
    });
    if (!open) return;
    for (const session of node.sessions) {
      rows.push({
        key: `session:${session}`,
        kind: "session",
        id: session,
        depth: depth + 1,
        label: projection.sessionName(session) ?? session,
        state: node.state === "running" ? "running" : "quiet",
        children: false,
        open: true,
      });
    }
    for (const child of node.children) walk(child, depth + 1);
  };
  walk("root", 0);
  return rows;
}

/** The keys the tree answers to, drawn at the foot of the pane while it holds focus. */
export function treeKeys(width: number): string[] {
  return ["arrows move, left and right fold", "enter opens, y copies, esc types", "q goes to the dashboard"].map(
    (line) => cut(` ${line}`, width),
  );
}

export function Tree({
  rows,
  selected,
  frame,
  width,
  height,
  onPick,
}: {
  rows: TreeRow[];
  selected: Selection;
  frame: number;
  width: number;
  height: number;
  onPick(row: TreeRow): void;
}): ReactNode {
  return (
    <box style={{ flexDirection: "column" }}>
      {inView(rows, selected, height).map((row) => (
        <box key={row.key} style={{ flexDirection: "column" }} onMouseDown={() => onPick(row)}>
          <TreeLine row={row} selected={isSelected(row, selected)} frame={frame} width={width} />
        </box>
      ))}
    </box>
  );
}

/** The rows the pane has room for, the selected row among them. */
function inView(rows: TreeRow[], selected: Selection, height: number): TreeRow[] {
  if (rows.length <= height) return rows;
  const at = Math.max(0, rows.findIndex((row) => isSelected(row, selected)));
  const start = Math.max(0, Math.min(rows.length - height, at - Math.floor(height / 2)));
  return rows.slice(start, start + height);
}

export function isSelected(row: TreeRow, selected: Selection): boolean {
  return row.kind === selected.kind && row.id === selected.id;
}

function TreeLine({
  row,
  selected,
  frame,
  width,
}: {
  row: TreeRow;
  selected: boolean;
  frame: number;
  width: number;
}): ReactNode {
  const lead = `${selected ? ">" : " "} ${" ".repeat(row.depth * 2)}${row.children ? (row.open ? "▾" : "▸") : " "}`;
  const room = Math.max(6, width - lead.length - 2);
  const label = cut(row.label, room);
  const detail = row.detail === undefined ? "" : cut(row.detail, Math.max(4, room - label.length - 1));
  return (
    <text>
      <span fg={selected ? ink.accent : ink.faint}>{lead}</span>
      <span fg={stateColor(row.state)}>{glyph(row.state, frame)}</span>
      <span fg={selected ? ink.text : ink.dim}>{` ${label}`}</span>
      {detail === "" ? null : <span fg={ink.faint}>{` ${detail}`}</span>}
    </text>
  );
}
