import { useEffect, useRef } from "react";
import type { CSSProperties, MouseEvent } from "react";
import type { FileTreeSortEntry, GitStatusEntry } from "@pierre/trees";
import { FileTree as TreeView, useFileTree as useTreeModel } from "@pierre/trees/react";

import { useDark } from "@/hooks/use-dark";

/**
 * The renderer's own palette, remapped onto app tokens. Custom properties inherit through the
 * shadow boundary, so the host carries them and the tree's fallback chain
 * (--trees-*-override -> --trees-theme-* -> default) picks them up.
 */
const TREE_STYLE = {
  "--trees-bg-override": "transparent",
  "--trees-fg-override": "var(--foreground)",
  "--trees-fg-muted-override": "var(--muted-foreground)",
  "--trees-bg-muted-override": "var(--accent)",
  "--trees-accent-override": "var(--primary)",
  "--trees-border-color-override": "var(--border)",
  "--trees-indent-guide-bg-override": "var(--border)",
  "--trees-scrollbar-thumb-override": "var(--border)",
  "--trees-selected-bg-override": "var(--accent)",
  "--trees-selected-fg-override": "var(--accent-foreground)",
  "--trees-selected-focused-border-color-override": "var(--ring)",
  "--trees-focus-ring-color-override": "var(--ring)",
  "--trees-font-family-override": "var(--font-sans)",
  "--trees-font-size-override": "12px",
  "--trees-border-radius-override": "var(--radius-sm)",
  "--trees-git-added-color-override": "var(--success)",
  "--trees-git-untracked-color-override": "var(--success)",
  "--trees-git-modified-color-override": "var(--warning)",
  "--trees-git-renamed-color-override": "var(--warning)",
  "--trees-git-deleted-color-override": "var(--destructive)",
  "--trees-git-ignored-color-override": "var(--muted-foreground)",
} as CSSProperties;

/** A directory at this depth, whether it is the entry itself or a folder on the way to it. */
function directoryAt(entry: FileTreeSortEntry, depth: number): boolean {
  return depth !== entry.segments.length - 1 || entry.isDirectory;
}

/**
 * opencode's order, which the renderer's own sort does not offer: within a folder, directories
 * lead, then names as the locale collates them, which files the dotfiles among their neighbours
 * instead of ahead of them. The renderer sorts one flat path list, so the comparison walks
 * segments rather than reading the name alone.
 */
function byName(left: FileTreeSortEntry, right: FileTreeSortEntry): number {
  const shared = Math.min(left.segments.length, right.segments.length);
  for (let depth = 0; depth < shared; depth += 1) {
    const here = left.segments[depth];
    const there = right.segments[depth];
    if (here === undefined || there === undefined || here === there) continue;
    if (directoryAt(left, depth) !== directoryAt(right, depth)) {
      return directoryAt(left, depth) ? -1 : 1;
    }
    const order = here.localeCompare(there);
    if (order !== 0) return order;
    return here < there ? -1 : 1;
  }
  if (left.segments.length !== right.segments.length) {
    return left.segments.length < right.segments.length ? -1 : 1;
  }
  if (left.isDirectory === right.isDirectory) return 0;
  return left.isDirectory ? -1 : 1;
}

export type FileTreeProps = {
  /** Every path the tree shows. Directories end in "/". */
  paths: readonly string[];
  /** Ignored and changed paths, in @pierre/trees' own vocabulary. */
  status: readonly GitStatusEntry[];
  active: string | undefined;
  onSelect: (path: string) => void;
  onSelectPermanent: (path: string) => void;
  /** Fired for a directory that is expanded but not listed yet. */
  onExpand: (dir: string) => void;
  className?: string;
};

function rowPath(event: MouseEvent<HTMLElement>): string | undefined {
  for (const node of event.nativeEvent.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.dataset.itemType !== "file") continue;
    return node.dataset.itemPath;
  }
  return undefined;
}

/** The one adapter around the tree renderer, so lazy listing and app styling stay paired. */
export function FileTree(props: FileTreeProps) {
  const dark = useDark();
  const held = useRef(props);
  held.current = props;

  const { model } = useTreeModel({
    paths: props.paths,
    sort: byName,
    initialExpansion: "closed",
    gitStatus: props.status,
    onSelectionChange: (selected) => {
      const path = selected[0];
      if (path === undefined || path === held.current.active) return;
      if (model.getItem(path)?.isDirectory() !== false) return;
      held.current.onSelect(path);
    },
  });

  const expanded = useRef(new Set<string>());
  const applied = useRef(props.paths);
  const scrolled = useRef<string | undefined>(undefined);

  // The model has no expansion callback, so every notification is a chance to notice a
  // directory that was opened and never listed. Rows under a collapsed parent are absent
  // from the sweep, which is why their expansion is remembered rather than re-derived.
  useEffect(() => {
    let pending = 0;
    const sweep = () => {
      pending = 0;
      const rows = model.getVisibleRows(0, model.getVisibleCount());
      for (const row of rows) {
        if (row.kind !== "directory") continue;
        if (!row.isExpanded) {
          expanded.current.delete(row.path);
          continue;
        }
        expanded.current.add(row.path);
        held.current.onExpand(row.path);
      }
    };

    sweep();
    const stop = model.subscribe(() => {
      if (pending !== 0) return;
      pending = requestAnimationFrame(sweep);
    });

    return () => {
      if (pending !== 0) cancelAnimationFrame(pending);
      stop();
    };
  }, [model]);

  useEffect(() => {
    if (applied.current === props.paths) return;
    applied.current = props.paths;
    model.resetPaths(props.paths, { initialExpandedPaths: [...expanded.current] });
  }, [model, props.paths]);

  useEffect(() => {
    model.setGitStatus(props.status);
  }, [model, props.status]);

  // Follow the active file, but only when it changes or first reaches the tree. Expanding a
  // folder reshuffles the rows and must not drag the view along with it.
  useEffect(() => {
    const active = props.active;
    if (active === undefined) {
      scrolled.current = undefined;
      return;
    }
    const item = model.getItem(active);
    if (item === null) return;
    if (!item.isSelected()) item.select();
    if (scrolled.current === active) return;
    scrolled.current = active;
    model.scrollToPath(active, { offset: "nearest" });
  }, [model, props.active, props.paths]);

  return (
    <TreeView
      model={model}
      className={props.className}
      style={{ ...TREE_STYLE, colorScheme: dark ? "dark" : "light" }}
      onDoubleClick={(event) => {
        const path = rowPath(event);
        if (path === undefined) return;
        held.current.onSelectPermanent(path);
      }}
    />
  );
}
