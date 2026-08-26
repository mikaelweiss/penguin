import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  FileDiffIcon,
  PilcrowIcon,
  RefreshCwIcon,
  Rows3Icon,
  TextWrapIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { CodeViewDiffItem, CodeViewItem } from "@pierre/diffs";

import { Button } from "@workspace/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { Separator } from "@workspace/ui/components/separator";
import { Toggle } from "@workspace/ui/components/toggle";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@workspace/ui/components/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";

import { DiffCodeView } from "@/components/diff-code-view";
import { PanelChrome } from "@/components/panel-chrome";
import { useDark } from "@/hooks/use-dark";
import type { DiffViewState } from "@/hooks/use-diff-view";
import { useRunDiff } from "@/hooks/use-run-diff";
import { diffStat, diffTheme, fileKey, filePath, parseDiff } from "@/lib/diff";

type DiffPanelProps = {
  dir: string;
  /** How much the run has written. A change means the files on disk may have moved with it. */
  wrote: number;
  view: DiffViewState;
  full: boolean;
  onToggleFull: () => void;
  onClose: () => void;
};

export function DiffPanel({
  dir,
  wrote,
  view,
  full,
  onToggleFull,
  onClose,
}: DiffPanelProps) {
  const { diff, plain, reading, error, reread } = useRunDiff(
    dir,
    wrote,
    view.ignoreWhitespace,
  );
  const theme = diffTheme(useDark());
  const parsed = useMemo(() => parseDiff(diff?.patch ?? ""), [diff?.patch]);
  const files = parsed?.kind === "files" ? parsed.files : undefined;
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  const [remounts, setRemounts] = useState(0);

  // Keys name files, so a run in another directory carries none of the last one's folded rows.
  useEffect(() => setShut(new Set()), [dir]);

  const keys = useMemo(() => (files ?? []).map(fileKey), [files]);
  const allShut = keys.length > 0 && keys.every((key) => shut.has(key));

  const toggleFile = useCallback((key: string) => {
    setShut((held) => {
      const next = new Set(held);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  // Folding every file at once leaves the virtualizer measuring the heights it had. Remount it.
  const toggleAll = () => {
    setRemounts((count) => count + 1);
    setShut(allShut ? new Set() : new Set(keys));
  };

  /**
   * The renderer draws its header inside a shadow root, so the row is not a React child. The
   * only handle on which file was clicked is the path its header prints.
   */
  const foldFromHeader = (event: React.MouseEvent) => {
    const header = event.nativeEvent
      .composedPath()
      .find(
        (node): node is HTMLElement =>
          node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
      );
    const clicked = header?.querySelector("[data-title]")?.textContent?.trim();
    if (clicked === undefined || clicked === "") return;
    const file = (files ?? []).find((one) => filePath(one) === clicked);
    if (file !== undefined) toggleFile(fileKey(file));
  };

  const items = useMemo<CodeViewDiffItem[]>(
    () =>
      (files ?? []).map((file) => {
        const key = fileKey(file);
        const collapsed = shut.has(key);
        return {
          id: key,
          type: "diff",
          fileDiff: file,
          collapsed,
          version: collapsed ? 1 : 0,
        };
      }),
    [files, shut],
  );

  const stat = files === undefined ? undefined : diffStat(files);

  return (
    <PanelChrome
      name="diff"
      full={full}
      onToggleFull={onToggleFull}
      onClose={onClose}
      title={
        <>
          <span className="shrink-0">Diff</span>
          {diff === undefined ? null : (
            <span className="truncate font-mono text-[0.6875rem] opacity-70">
              against {diff.base}
            </span>
          )}
          {stat === undefined ? null : (
            <span className="shrink-0 tabular-nums">
              <span className="text-success">+{stat.additions}</span>{" "}
              <span className="text-destructive">-{stat.deletions}</span>
            </span>
          )}
        </>
      }
      tools={
        <>
          <IconTooltip label="Re-read the diff">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Re-read the diff"
              onClick={reread}
            >
              <RefreshCwIcon className={cn(reading && "animate-spin")} />
            </Button>
          </IconTooltip>
          {keys.length > 0 ? (
            <IconTooltip
              label={allShut ? "Expand all files" : "Collapse all files"}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={allShut ? "Expand all files" : "Collapse all files"}
                onClick={toggleAll}
              >
                {allShut ? <ChevronsUpDownIcon /> : <ChevronsDownUpIcon />}
              </Button>
            </IconTooltip>
          ) : null}
          <Separator
            orientation="vertical"
            className="h-4 data-vertical:self-center"
          />
          <ToggleGroup
            type="single"
            size="sm"
            spacing={0}
            value={view.split ? "split" : "unified"}
            onValueChange={(picked) => {
              if (picked !== "") view.set({ split: picked === "split" });
            }}
          >
            <ToggleGroupItem
              value="unified"
              aria-label="One column"
              className="size-6 min-w-6 px-0"
            >
              <Rows3Icon />
            </ToggleGroupItem>
            <ToggleGroupItem
              value="split"
              aria-label="Side by side"
              className="size-6 min-w-6 px-0"
            >
              <Columns2Icon />
            </ToggleGroupItem>
          </ToggleGroup>
          <IconTooltip
            label={view.wrap ? "Stop wrapping lines" : "Wrap long lines"}
          >
            <Toggle
              size="sm"
              className="size-6 min-w-6 px-0"
              aria-label={view.wrap ? "Stop wrapping lines" : "Wrap long lines"}
              pressed={view.wrap}
              onPressedChange={(pressed) => view.set({ wrap: pressed })}
            >
              <TextWrapIcon />
            </Toggle>
          </IconTooltip>
          <IconTooltip
            label={
              view.ignoreWhitespace
                ? "Show whitespace changes"
                : "Hide whitespace changes"
            }
          >
            <Toggle
              size="sm"
              className="size-6 min-w-6 px-0"
              aria-label={
                view.ignoreWhitespace
                  ? "Show whitespace changes"
                  : "Hide whitespace changes"
              }
              pressed={view.ignoreWhitespace}
              onPressedChange={(pressed) =>
                view.set({ ignoreWhitespace: pressed })
              }
            >
              <PilcrowIcon />
            </Toggle>
          </IconTooltip>
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        {error !== undefined ? (
          <Note
            icon={<TriangleAlertIcon />}
            title="Cannot read the diff"
            detail={error}
          />
        ) : plain ? (
          <Note
            icon={<FileDiffIcon />}
            title="Not a git directory"
            detail={`${dir} sits outside any repository, so there is nothing to compare.`}
          />
        ) : parsed === undefined ? (
          <Note
            icon={<FileDiffIcon />}
            title="No changes"
            detail={
              diff === undefined
                ? "Reading the run's directory."
                : view.ignoreWhitespace
                  ? `Nothing but spacing differs from ${diff.base}.`
                  : `Nothing differs from ${diff.base}.`
            }
          />
        ) : parsed.kind === "raw" ? (
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <p className="text-xs text-muted-foreground">{parsed.reason}</p>
            <pre
              className={cn(
                "mt-2 font-mono text-xs",
                view.wrap
                  ? "whitespace-pre-wrap break-words"
                  : "whitespace-pre",
              )}
            >
              {parsed.text}
            </pre>
          </div>
        ) : (
          <div
            className="flex min-h-0 flex-1 flex-col"
            onClick={foldFromHeader}
          >
            <DiffCodeView
              key={remounts}
              items={items}
              className="min-h-0 flex-1 overflow-auto"
              renderHeaderPrefix={(item) => (
                <FileChevron item={item} onToggle={toggleFile} />
              )}
              options={{
                theme,
                diffStyle: view.split ? "split" : "unified",
                diffIndicators: "bars",
                hunkSeparators: "line-info",
                lineDiffType: "word",
                overflow: view.wrap ? "wrap" : "scroll",
                enableLineSelection: false,
                enableGutterUtility: false,
              }}
            />
          </div>
        )}
        {diff?.truncated === true ? (
          <p className="shrink-0 border-t px-3 py-1.5 text-xs text-muted-foreground">
            The patch is larger than the panel reads. Later files are left out.
          </p>
        ) : null}
      </div>
    </PanelChrome>
  );
}

function FileChevron({
  item,
  onToggle,
}: {
  item: CodeViewItem;
  onToggle: (key: string) => void;
}) {
  if (item.type !== "diff") return null;
  const collapsed = item.collapsed === true;
  const path = filePath(item.fileDiff);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="-ms-0.5"
      aria-label={collapsed ? `Expand ${path}` : `Collapse ${path}`}
      aria-expanded={!collapsed}
      onClick={(event) => {
        // The header behind this button folds on click too. Let it through and the two cancel.
        event.stopPropagation();
        onToggle(item.id);
      }}
    >
      {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
    </Button>
  );
}

function IconTooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Note({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription className="break-all">{detail}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
