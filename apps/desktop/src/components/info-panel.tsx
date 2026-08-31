import { useMemo } from "react";
import { InfoIcon } from "lucide-react";

import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Separator } from "@workspace/ui/components/separator";

import { PanelChrome } from "@/components/panel-chrome";
import { useRunDiff } from "@/hooks/use-run-diff";
import { diffStat, parseDiff } from "@/lib/diff";
import { costLabel, subtreeCost, type Cost, type Run } from "@/lib/runs";

type InfoPanelProps = {
  run: Run;
  /** How much the run has written. A change means the files on disk may have moved with it. */
  wrote: number;
  full: boolean;
  onOpenUrl: (url: string) => void;
  onShowDiff: () => void;
  onToggleFull: () => void;
  onClose: () => void;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 px-3 py-1.5">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        {children}
      </div>
    </div>
  );
}

function Link({ url, onOpen, children }: { url: string; onOpen: (url: string) => void; children: React.ReactNode }) {
  return (
    <Button
      variant="link"
      size="sm"
      className="h-auto min-w-0 max-w-full justify-start p-0"
      onClick={() => onOpen(url)}
    >
      <span className="truncate">{children}</span>
    </Button>
  );
}

function tokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function breakdown(cost: Cost): string {
  const turns = cost.turns === 1 ? "1 turn" : `${cost.turns} turns`;
  return `${turns} · in ${tokens(cost.input)} · cache read ${tokens(cost.cacheRead)} · cache write ${tokens(cost.cacheWrite)} · out ${tokens(cost.output)}`;
}

/** The clock time an entry stamp carries, since "as of" only matters within a working day. */
function when(at: string): string {
  const stamp = new Date(at);
  return Number.isNaN(stamp.getTime())
    ? at
    : stamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function started(at: string): string {
  const stamp = new Date(at);
  return Number.isNaN(stamp.getTime()) ? at : stamp.toLocaleString();
}

function prState(pr: NonNullable<Run["pr"]>): string {
  if (pr.state === "OPEN" && pr.isDraft) return "draft";
  return pr.state.toLowerCase();
}

/**
 * What the run file says about the run: where it works, what it spent, what it changed, and the
 * pull request and ticket as the run last read them. Nothing here polls; every figure names its
 * source, and the PR and ticket rows say when the run last looked.
 */
export function InfoPanel({
  run,
  wrote,
  full,
  onOpenUrl,
  onShowDiff,
  onToggleFull,
  onClose,
}: InfoPanelProps) {
  const { diff, plain } = useRunDiff(run.dir, wrote, false);
  const stat = useMemo(() => {
    const parsed = parseDiff(diff?.patch ?? "");
    return parsed?.kind === "files" ? diffStat(parsed.files) : undefined;
  }, [diff?.patch]);
  const tree = subtreeCost(run);
  const own = costLabel(run.cost);
  const treeLabel = costLabel(tree);
  const worktree = run.dir !== run.cwd;
  const links = run.opens.filter((url) => url !== run.pr?.url && url !== run.ticket?.url);

  return (
    <PanelChrome
      title={
        <>
          <InfoIcon className="size-3.5 shrink-0" />
          <span className="truncate">Info</span>
        </>
      }
      name="info"
      full={full}
      onToggleFull={onToggleFull}
      onClose={onClose}
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-2">
        <Row label="Run">
          <span className="truncate">{run.name}</span>
          <span className="text-muted-foreground">{run.status}</span>
          <span className="text-xs text-muted-foreground">started {started(run.at)}</span>
        </Row>
        <Row label="Cost">
          {tree === undefined ? (
            <span className="text-muted-foreground">no usage recorded</span>
          ) : (
            <>
              <span className="tabular-nums">{treeLabel}</span>
              {own !== undefined && own !== treeLabel ? (
                <span className="text-xs text-muted-foreground">this run {own}</span>
              ) : null}
              <span className="text-xs text-muted-foreground tabular-nums">{breakdown(tree)}</span>
            </>
          )}
        </Row>
        <Separator className="my-2" />
        {worktree ? (
          <Row label="Worktree">
            <span className="truncate font-mono text-xs" title={run.dir}>
              {run.dir}
            </span>
          </Row>
        ) : null}
        <Row label="Directory">
          <span className="truncate font-mono text-xs" title={run.cwd}>
            {run.cwd}
          </span>
        </Row>
        <Row label="Change">
          {plain ? (
            <span className="text-muted-foreground">not a git repository</span>
          ) : stat === undefined || stat.files === 0 ? (
            <span className="text-muted-foreground">no uncommitted changes</span>
          ) : (
            <>
              <span className="tabular-nums">
                {stat.files === 1 ? "1 file" : `${stat.files} files`}, +{stat.additions} −
                {stat.deletions}
              </span>
              {diff === undefined ? null : (
                <span className="text-xs text-muted-foreground">against {diff.base}</span>
              )}
              <Button variant="link" size="sm" className="h-auto p-0" onClick={onShowDiff}>
                Open the diff
              </Button>
            </>
          )}
        </Row>
        {run.pr !== undefined || run.ticket !== undefined || links.length > 0 ? (
          <Separator className="my-2" />
        ) : null}
        {run.pr !== undefined ? (
          <Row label="Pull request">
            <Link url={run.pr.url} onOpen={onOpenUrl}>
              {run.pr.number === undefined ? run.pr.url : `#${run.pr.number}`}
              {run.pr.title === undefined ? "" : ` ${run.pr.title}`}
            </Link>
            <Badge variant="secondary">{prState(run.pr)}</Badge>
            {run.pr.isInMergeQueue ? <Badge variant="secondary">in merge queue</Badge> : null}
            <span className="text-xs text-muted-foreground">as of {when(run.pr.at)}</span>
          </Row>
        ) : null}
        {run.ticket !== undefined ? (
          <Row label={run.ticket.source === "jira" ? "Jira" : "Issue"}>
            {run.ticket.url === undefined ? (
              <span className="truncate">{run.ticket.name}</span>
            ) : (
              <Link url={run.ticket.url} onOpen={onOpenUrl}>
                {run.ticket.name}
                {run.ticket.title === undefined ? "" : ` ${run.ticket.title}`}
              </Link>
            )}
            <Badge variant="secondary">{run.ticket.status.toLowerCase()}</Badge>
            <span className="text-xs text-muted-foreground">as of {when(run.ticket.at)}</span>
          </Row>
        ) : null}
        {links.length > 0 ? (
          <Row label="Links">
            <div className="flex min-w-0 flex-col items-start gap-1">
              {links.map((url) => (
                <Link key={url} url={url} onOpen={onOpenUrl}>
                  {url}
                </Link>
              ))}
            </div>
          </Row>
        ) : null}
      </div>
    </PanelChrome>
  );
}
