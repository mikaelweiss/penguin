import { useCallback, useEffect, useMemo, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  Columns2Icon,
  FileDiffIcon,
  FoldVerticalIcon,
  Rows3Icon,
  SearchIcon,
  TriangleAlertIcon,
  UnfoldVerticalIcon,
  XIcon,
} from "lucide-react";
import type { CodeViewDiffItem } from "@pierre/diffs";

import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@workspace/ui/components/input-group";
import { ScrollArea } from "@workspace/ui/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Spinner } from "@workspace/ui/components/spinner";
import { ToggleGroup, ToggleGroupItem } from "@workspace/ui/components/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";

import { DiffCodeView } from "@/components/diff-code-view";
import { FileTree } from "@/components/file-tree";
import { PanelSidebarHandle } from "@/components/panel-sidebar-handle";
import { applyFileListKeyDown, ReviewFileList } from "@/components/review-file-list";
import { useDark } from "@/hooks/use-dark";
import type { DiffStyle, ExpandMode } from "@/hooks/use-panels";
import type { ReviewState } from "@/hooks/use-review";
import { diffTheme, parseFileDiff } from "@/lib/diff";
import { directoryOf, fileNameOf } from "@/lib/file-path";
import type { BaseChoice, FileChange, FileStatus, ReviewRoot } from "@/lib/files";
import { filterReviewFiles, statusEntries, statusLabel } from "@/lib/review-kinds";

const BADGE = { added: "default", deleted: "destructive", modified: "warning" } as const;

export type ReviewTabProps = {
  root: ReviewRoot | undefined;
  base: BaseChoice;
  onBaseChange: (base: BaseChoice) => void;
  review: ReviewState;
  sidebarOpen: boolean;
  sidebarWidth: number;
  onSidebarWidth: (width: number) => void;
  diffStyle: DiffStyle;
  onDiffStyle: (style: DiffStyle) => void;
  expandMode: ExpandMode;
  onExpandMode: (mode: ExpandMode) => void;
  /** The file whose diff is shown. The tab owner persists it. */
  activeFile: string | undefined;
  onSelectFile: (file: string) => void;
};

/** What the run changed against its base: the file list on the left, one file's diff on the right. */
export function ReviewTab({
  root,
  base,
  onBaseChange,
  review,
  sidebarOpen,
  sidebarWidth,
  onSidebarWidth,
  diffStyle,
  onDiffStyle,
  expandMode,
  onExpandMode,
  activeFile,
  onSelectFile,
}: ReviewTabProps) {
  const [filter, setFilter] = useState("");
  const [highlight, setHighlight] = useState<string | undefined>(undefined);
  const theme = diffTheme(useDark());

  const paths = useMemo(() => review.files.map((file) => file.file), [review.files]);
  const filtered = useMemo(() => filterReviewFiles(paths, filter), [paths, filter]);
  const searching = filter.trim() !== "";

  // While filtering, the owner's file stands whatever the query hides. Otherwise it has to be one
  // the list still holds, else the list leads with its first.
  const active = searching
    ? activeFile
    : activeFile !== undefined && filtered.includes(activeFile)
      ? activeFile
      : filtered[0];

  const change = review.files.find((file) => file.file === active);
  const status = useMemo(
    () => new Map<string, FileStatus>(review.files.map((file) => [file.file, file.status])),
    [review.files],
  );
  // Every row in a changes-only tree is already a change, so only added and deleted earn a badge.
  const treeStatus = useMemo(
    () => statusEntries(review.files).filter((entry) => entry.status !== "modified"),
    [review.files],
  );

  const found = active === undefined ? -1 : filtered.indexOf(active);
  const at = found < 0 ? 0 : found;

  const step = useCallback(
    (delta: number) => {
      if (filtered.length === 0) return;
      const next = filtered[(at + delta + filtered.length) % filtered.length];
      if (next !== undefined) onSelectFile(next);
    },
    [filtered, at, onSelectFile],
  );

  // The advertised arrow keys work while the tab is mounted, never while typing.
  useEffect(() => {
    const walk = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select") !== null)
      ) {
        return;
      }
      if (filtered.length === 0) return;
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    };

    document.addEventListener("keydown", walk);
    return () => document.removeEventListener("keydown", walk);
  }, [filtered.length, step]);

  const highlighted = !searching
    ? undefined
    : highlight !== undefined && filtered.includes(highlight)
      ? highlight
      : filtered[0];

  const onFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!searching) return;
    applyFileListKeyDown(event.nativeEvent, filtered, highlighted, {
      onHighlight: setHighlight,
      onSelect: onSelectFile,
    });
  };

  const picker = (
    <Select value={base} onValueChange={(picked) => onBaseChange(picked as BaseChoice)}>
      <SelectTrigger size="sm" aria-label="Measure the review from">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value="auto">Auto</SelectItem>
        <SelectItem value="head">HEAD</SelectItem>
        <SelectItem value="branch">{root?.defaultBranch ?? "Branch base"}</SelectItem>
      </SelectContent>
    </Select>
  );

  const stat = (
    <span className="shrink-0 text-xs tabular-nums">
      <span className="text-success">+{review.stat.additions}</span>{" "}
      <span className="text-destructive">-{review.stat.deletions}</span>
    </span>
  );

  return (
    <div className="flex min-h-0 flex-1 bg-background">
      {sidebarOpen ? (
        <aside
          className="relative flex min-h-0 shrink-0 flex-col border-r"
          style={{ width: `${sidebarWidth}px` }}
        >
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
            <div className="min-w-0 flex-1">{picker}</div>
            {stat}
          </div>
          <div className="shrink-0 p-2">
            <InputGroup>
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                value={filter}
                placeholder="Filter files"
                aria-label="Filter files"
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={onFilterKeyDown}
              />
              {filter === "" ? null : (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Clear the filter"
                    onClick={() => setFilter("")}
                  >
                    <XIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
          </div>
          <div className="min-h-0 flex-1">
            {!review.ready ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">Reading the changes.</p>
            ) : !searching ? (
              <FileTree
                paths={filtered}
                status={treeStatus}
                active={active}
                onSelect={onSelectFile}
                onSelectPermanent={onSelectFile}
                onExpand={listed}
                className="h-full w-full"
              />
            ) : filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">No matches</p>
            ) : (
              <ScrollArea className="h-full">
                <ReviewFileList
                  files={filtered}
                  active={active}
                  highlighted={highlighted}
                  status={status}
                  onFileClick={(path) => {
                    setHighlight(path);
                    onSelectFile(path);
                  }}
                />
              </ScrollArea>
            )}
          </div>
          <PanelSidebarHandle width={sidebarWidth} onWidth={onSidebarWidth} />
        </aside>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {review.files.length > 0 ? (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2">
            {sidebarOpen ? null : (
              <div className="flex min-w-0 items-center gap-2">
                {picker}
                {stat}
                {filtered.length === 0 ? null : (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {at + 1}/{filtered.length}
                  </span>
                )}
              </div>
            )}
            <div className="flex items-center">
              <IconTooltip label="Previous file">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Previous file"
                  disabled={filtered.length === 0}
                  onClick={() => step(-1)}
                >
                  <ArrowLeftIcon />
                </Button>
              </IconTooltip>
              <IconTooltip label="Next file">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Next file"
                  disabled={filtered.length === 0}
                  onClick={() => step(1)}
                >
                  <ArrowRightIcon />
                </Button>
              </IconTooltip>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <ToggleGroup
                type="single"
                size="sm"
                spacing={0}
                value={expandMode}
                onValueChange={(picked) => {
                  if (picked === "expand" || picked === "collapse") onExpandMode(picked);
                }}
              >
                <ToggleGroupItem
                  value="expand"
                  aria-label="Show all lines"
                  className="size-6 min-w-6 px-0"
                >
                  <UnfoldVerticalIcon />
                </ToggleGroupItem>
                <ToggleGroupItem
                  value="collapse"
                  aria-label="Hide unchanged lines"
                  className="size-6 min-w-6 px-0"
                >
                  <FoldVerticalIcon />
                </ToggleGroupItem>
              </ToggleGroup>
              <ToggleGroup
                type="single"
                size="sm"
                spacing={0}
                value={diffStyle}
                onValueChange={(picked) => {
                  if (picked === "unified" || picked === "split") onDiffStyle(picked);
                }}
              >
                <ToggleGroupItem
                  value="unified"
                  aria-label="Unified"
                  className="size-6 min-w-6 px-0"
                >
                  <Rows3Icon />
                </ToggleGroupItem>
                <ToggleGroupItem value="split" aria-label="Split" className="size-6 min-w-6 px-0">
                  <Columns2Icon />
                </ToggleGroupItem>
              </ToggleGroup>
            </div>
          </div>
        ) : null}
        <Viewer
          root={root}
          review={review}
          file={active}
          change={change}
          theme={theme}
          diffStyle={diffStyle}
          expandMode={expandMode}
        />
      </div>
    </div>
  );
}

/** The review tree already holds every changed file, so nothing is left to list. */
function listed() {}

type ViewerProps = {
  root: ReviewRoot | undefined;
  review: ReviewState;
  file: string | undefined;
  change: FileChange | undefined;
  theme: ReturnType<typeof diffTheme>;
  diffStyle: DiffStyle;
  expandMode: ExpandMode;
};

function Viewer({ root, review, file, change, theme, diffStyle, expandMode }: ViewerProps) {
  const fileDiff = useMemo(
    () => (change === undefined ? undefined : parseFileDiff(change.file, change.patch)),
    [change],
  );

  const items = useMemo<CodeViewDiffItem[]>(
    () =>
      fileDiff === undefined || file === undefined ? [] : [{ id: file, type: "diff", fileDiff }],
    [file, fileDiff],
  );

  if (root?.git === false) {
    return (
      <Note
        icon={<FileDiffIcon />}
        title="Not a git repository"
        detail={`${root.root} sits outside any repository, so there is nothing to review.`}
      />
    );
  }

  if (review.error !== undefined && review.files.length === 0) {
    return (
      <Note icon={<TriangleAlertIcon />} title="Cannot read the changes" detail={review.error} />
    );
  }

  if (!review.ready) return <Note icon={<Spinner />} title="Reading the changes" />;

  if (change === undefined || file === undefined) {
    return (
      <Note
        icon={<FileDiffIcon />}
        title="No changes"
        detail={`Nothing differs from ${review.base}.`}
      />
    );
  }

  const directory = directoryOf(file);

  return (
    <>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b px-3">
        <Badge variant={BADGE[change.status]} className="shrink-0">
          {statusLabel(change.status)}
        </Badge>
        <span className="shrink-0 truncate text-xs">{fileNameOf(file)}</span>
        {directory === "" ? null : (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{directory}</span>
        )}
        <span className="ml-auto shrink-0 text-xs tabular-nums">
          <span className="text-success">+{change.additions}</span>{" "}
          <span className="text-destructive">-{change.deletions}</span>
        </span>
      </div>
      {change.binary ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">This file is binary.</p>
      ) : change.truncated || fileDiff === undefined ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">This file is too large to show.</p>
      ) : (
        <DiffCodeView
          key={file}
          items={items}
          className="min-h-0 flex-1 overflow-auto"
          options={{
            theme,
            diffStyle,
            expandUnchanged: expandMode === "expand",
            hunkSeparators: fileDiff.isPartial ? "simple" : "line-info-basic",
            diffIndicators: "bars",
            lineDiffType: "word",
            overflow: "scroll",
            enableLineSelection: false,
            enableGutterUtility: false,
          }}
        />
      )}
    </>
  );
}

function IconTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Note({ icon, title, detail }: { icon: ReactNode; title: string; detail?: string }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {detail === undefined ? null : (
          <EmptyDescription className="break-all">{detail}</EmptyDescription>
        )}
      </EmptyHeader>
    </Empty>
  );
}
