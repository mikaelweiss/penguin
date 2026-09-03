import { useEffect, useRef } from "react";
import { FileIcon } from "lucide-react";

import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";

import { directoryOf, fileNameOf } from "@/lib/file-path";
import type { FileStatus } from "@/lib/files";
import { statusLabel } from "@/lib/review-kinds";

const BADGE = { added: "default", deleted: "destructive", modified: "warning" } as const;

/**
 * Drives the highlight and the selection of a filtered list from the filter input's keydown.
 * ArrowUp and ArrowDown move the highlight, Enter selects.
 */
export function applyFileListKeyDown(
  event: KeyboardEvent,
  files: readonly string[],
  highlighted: string | undefined,
  options: { onHighlight: (path: string) => void; onSelect: (path: string) => void },
): void {
  if (files.length === 0) return;

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const current = highlighted === undefined ? -1 : files.indexOf(highlighted);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const start = current === -1 ? (delta > 0 ? 0 : files.length - 1) : current + delta;
    const path = files[Math.max(0, Math.min(files.length - 1, start))];
    if (path !== undefined) options.onHighlight(path);
    event.preventDefault();
    return;
  }

  if (event.key !== "Enter") return;
  const target = highlighted ?? files[0];
  if (target === undefined) return;
  options.onSelect(target);
  event.preventDefault();
}

export type ReviewFileListProps = {
  files: readonly string[];
  active?: string;
  highlighted?: string;
  status?: ReadonlyMap<string, FileStatus>;
  id?: string;
  role?: "listbox";
  optionId?: (path: string) => string;
  onFileClick: (path: string) => void;
  onFileDoubleClick?: (path: string) => void;
};

/** The flat list a filter narrows to, standing in for the tree while the filter has a value. */
export function ReviewFileList({
  files,
  active,
  highlighted,
  status,
  id,
  role,
  optionId,
  onFileClick,
  onFileDoubleClick,
}: ReviewFileListProps) {
  const list = useRef<HTMLDivElement | null>(null);

  // The keyboard walks past the visible window, so the row it lands on has to come into view.
  useEffect(() => {
    if (highlighted === undefined) return;
    list.current?.querySelector<HTMLElement>("[data-highlighted=true]")?.scrollIntoView({
      block: "nearest",
    });
  }, [highlighted]);

  return (
    <div ref={list} id={id} role={role} className="flex flex-col gap-0.5 p-1">
      {files.map((path) => {
        const selected = highlighted === undefined ? active === path : highlighted === path;
        const directory = directoryOf(path);
        const kind = status?.get(path);
        return (
          <Button
            key={path}
            type="button"
            variant={selected ? "secondary" : "ghost"}
            size="sm"
            id={optionId?.(path)}
            role={role === undefined ? undefined : "option"}
            aria-selected={role === undefined ? undefined : selected}
            data-path={path}
            data-highlighted={highlighted === path}
            className="w-full justify-start gap-2 px-2"
            onClick={() => onFileClick(path)}
            onDoubleClick={() => onFileDoubleClick?.(path)}
          >
            <FileIcon className="shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap">
              {directory === "" ? null : (
                <span className="min-w-0 shrink truncate text-muted-foreground">{directory}/</span>
              )}
              <span className="shrink-0">{fileNameOf(path)}</span>
            </span>
            {kind === undefined ? null : (
              <Badge variant={BADGE[kind]} className="shrink-0">
                {statusLabel(kind)}
              </Badge>
            )}
          </Button>
        );
      })}
    </div>
  );
}
