import { useMemo } from "react";
import { FileDiffIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import type { CodeViewDiffItem } from "@pierre/diffs";

import { Button } from "@workspace/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";

import { DiffCodeView } from "@/components/diff-code-view";
import { PanelChrome } from "@/components/panel-chrome";
import { useDark } from "@/hooks/use-dark";
import { useRunDiff } from "@/hooks/use-run-diff";
import { diffStat, diffTheme, fileKey, parseDiff } from "@/lib/diff";

type DiffPanelProps = {
  dir: string;
  /** How much the run has written. A change means the files on disk may have moved with it. */
  wrote: number;
  full: boolean;
  onToggleFull: () => void;
  onClose: () => void;
};

export function DiffPanel({ dir, wrote, full, onToggleFull, onClose }: DiffPanelProps) {
  const { diff, plain, reading, error, reread } = useRunDiff(dir, wrote);
  const theme = diffTheme(useDark());
  const parsed = useMemo(() => parseDiff(diff?.patch ?? ""), [diff?.patch]);
  const files = parsed?.kind === "files" ? parsed.files : undefined;

  const items = useMemo<CodeViewDiffItem[]>(
    () => (files ?? []).map((file) => ({ id: fileKey(file), type: "diff", fileDiff: file })),
    [files],
  );

  const stat = files === undefined ? undefined : diffStat(files);
  const counted =
    stat === undefined
      ? undefined
      : `${stat.files} ${stat.files === 1 ? "file" : "files"}, +${stat.additions} -${stat.deletions}`;

  return (
    <PanelChrome
      name="diff"
      full={full}
      onToggleFull={onToggleFull}
      onClose={onClose}
      title={
        <>
          <span className="shrink-0">Diff</span>
          {counted === undefined ? null : (
            <span className="truncate tabular-nums">· {counted}</span>
          )}
          {diff === undefined ? null : (
            <span className="truncate font-mono text-[0.6875rem] opacity-70">
              against {diff.base}
            </span>
          )}
        </>
      }
      tools={
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Re-read the diff" onClick={reread}>
              <RefreshCwIcon className={cn(reading && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Re-read the diff</TooltipContent>
        </Tooltip>
      }
    >
      <Body>
        {error !== undefined ? (
          <Note icon={<TriangleAlertIcon />} title="Cannot read the diff" detail={error} />
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
                : `Nothing differs from ${diff.base}.`
            }
          />
        ) : parsed.kind === "raw" ? (
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <p className="text-xs text-muted-foreground">{parsed.reason}</p>
            <pre className="mt-2 font-mono text-xs whitespace-pre">{parsed.text}</pre>
          </div>
        ) : (
          <DiffCodeView
            items={items}
            className="min-h-0 flex-1 overflow-auto"
            options={{
              theme,
              diffStyle: "unified",
              diffIndicators: "bars",
              hunkSeparators: "line-info",
              lineDiffType: "word",
              overflow: "scroll",
              enableLineSelection: false,
              enableGutterUtility: false,
            }}
          />
        )}
        {diff?.truncated === true ? (
          <p className="shrink-0 border-t px-3 py-1.5 text-xs text-muted-foreground">
            The patch is larger than the panel reads. Later files are left out.
          </p>
        ) : null}
      </Body>
    </PanelChrome>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-0 flex-1 flex-col bg-background">{children}</div>;
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
