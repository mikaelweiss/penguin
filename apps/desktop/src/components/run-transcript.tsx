import {
  ActivityIcon,
  BotIcon,
  ChevronDownIcon,
  EyeIcon,
  GlobeIcon,
  ListTreeIcon,
  SearchIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { Markdown } from "@workspace/ui/components/markdown";
import { Marker, MarkerContent, MarkerIcon } from "@workspace/ui/components/marker";
import { Message, MessageContent } from "@workspace/ui/components/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@workspace/ui/components/message-scroller";
import { Spinner } from "@workspace/ui/components/spinner";
import { cn } from "@workspace/ui/lib/utils";

import { AttachmentRow } from "@/components/attachment-row";
import { useRunLog } from "@/hooks/use-run-log";
import type { ActionItem, ActionKind, OutputLine, Run, RunInput, RunState } from "@/lib/runs";
import { reuseRows, startsTurn, toRows, type TranscriptRow } from "@/lib/transcript";

/** The column every row shares, so prose and work sit on one grid. */
const COLUMN = "mx-auto w-full min-w-0 max-w-3xl";

/** A work row is one line tall, where the scroller's stock reserve assumes a whole message. */
const ONE_LINE = "[contain-intrinsic-size:auto_2rem]";

const ICONS: Record<ActionKind, LucideIcon> = {
  run: SquareTerminalIcon,
  read: EyeIcon,
  edit: SquarePenIcon,
  search: SearchIcon,
  fetch: GlobeIcon,
  agent: BotIcon,
};

function took(action: ActionItem): string | undefined {
  if (action.doneAt === undefined) return undefined;
  const ms = Date.parse(action.doneAt) - Date.parse(action.at);
  if (!Number.isFinite(ms) || ms < 1000) return undefined;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

function elapsed(since: string, now: number): string {
  const started = Date.parse(since);
  if (Number.isNaN(started)) return "";
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function useSecond(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Everything the run wrote is prose in one column. Only a problem carries its own colour. */
const LineRow = memo(function LineRow({ line }: { line: OutputLine }) {
  return (
    <Message>
      <MessageContent className={line.kind === "problem" ? "text-destructive" : undefined}>
        <Markdown>{line.text}</Markdown>
        {line.attachments ? <AttachmentRow files={line.attachments} /> : null}
      </MessageContent>
    </Message>
  );
});

const FOLD_LINES = 3;
const FOLD_CHARS = 300;

function folded(value: string): boolean {
  return value.length > FOLD_CHARS || value.split("\n").length > FOLD_LINES;
}

/**
 * Only rows that own a disclosure take this. Prose rows do not, so toggling one open never
 * re-renders a markdown block.
 */
type DisclosureProps = { open: ReadonlySet<string>; onToggle: (key: string) => void };

/** One shared instance, so a run with nothing open does not hand its rows a new set each tick. */
const NOTHING_OPEN: ReadonlySet<string> = new Set();

function InputValue({
  entry,
  label,
  open,
  onToggle,
}: { entry: RunInput; label: boolean } & DisclosureProps) {
  const name = label ? <span className="text-xs text-muted-foreground">{entry.name}</span> : null;
  const key = `input:${entry.name}`;
  const showing = open.has(key);

  if (!folded(entry.text)) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {name}
        <Markdown>{entry.text}</Markdown>
      </div>
    );
  }

  return (
    <Collapsible
      open={showing}
      onOpenChange={() => onToggle(key)}
      className="flex min-w-0 flex-col gap-1"
    >
      <CollapsibleTrigger className="flex min-w-0 cursor-pointer items-center gap-2 text-start">
        <ChevronDownIcon
          className={cn("size-4 shrink-0 transition-transform", showing && "rotate-180")}
        />
        {name}
        <span className="truncate">{entry.text.split("\n")[0]}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="max-h-96 overflow-auto border-s ps-3">
        <Markdown>{entry.text}</Markdown>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** What the run was started with, so the prompt outlives the dialog that sent it. */
const InputRow = memo(function InputRow({
  input,
  open,
  onToggle,
}: { input: RunInput[] } & DisclosureProps) {
  return (
    <Message>
      <MessageContent>
        {input.map((entry) => (
          <InputValue
            key={entry.name}
            entry={entry}
            label={input.length > 1}
            open={open}
            onToggle={onToggle}
          />
        ))}
      </MessageContent>
    </Message>
  );
});

function ActionRow({
  action,
  spinning,
  open,
  onToggle,
}: { action: ActionItem; spinning: boolean } & DisclosureProps) {
  const Icon = action.kind === undefined ? WrenchIcon : ICONS[action.kind];
  const failed = action.status === "failed";
  const duration = took(action);
  const key = `action:${action.id}`;
  const showing = open.has(key);

  const label = (
    <>
      <MarkerIcon className={failed ? "text-destructive" : undefined}>
        {spinning ? <Spinner /> : <Icon />}
      </MarkerIcon>
      <MarkerContent className={cn("flex-1 truncate", failed && "text-destructive")}>
        {action.name}
        {action.target === undefined ? null : (
          <span className="ms-2 font-mono">{action.target}</span>
        )}
      </MarkerContent>
      {duration === undefined ? null : <span className="shrink-0 tabular-nums">{duration}</span>}
      {action.output === undefined ? null : (
        <ChevronDownIcon className={cn("transition-transform", showing && "rotate-180")} />
      )}
    </>
  );

  if (action.output === undefined) return <Marker>{label}</Marker>;

  return (
    <Collapsible open={showing} onOpenChange={() => onToggle(key)}>
      <CollapsibleTrigger asChild>
        <Marker asChild>
          <button type="button" className="cursor-pointer">
            {label}
          </button>
        </Marker>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap border-s ps-3 font-mono text-xs/5">
          {action.output}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

type ActionsRowProps = {
  row: Extract<TranscriptRow, { kind: "actions" }>;
  live: boolean;
} & DisclosureProps;

/** Contiguous tool calls fold into one summary row; the newest stays visible while it runs. */
const ActionsRow = memo(function ActionsRow({ row, live, open, onToggle }: ActionsRowProps) {
  const last = row.actions.at(-1)!;
  const streaming = live && last.status === "running";
  const showing = open.has(row.key);

  if (row.actions.length === 1) {
    return <ActionRow action={last} spinning={streaming} open={open} onToggle={onToggle} />;
  }

  const shown = showing ? row.actions : streaming ? [last] : [];
  return (
    <Collapsible open={showing} onOpenChange={() => onToggle(row.key)}>
      <CollapsibleTrigger asChild>
        <Marker asChild>
          <button type="button" className="cursor-pointer">
            <MarkerIcon>
              <ChevronDownIcon className={cn("transition-transform", showing && "rotate-180")} />
            </MarkerIcon>
            <MarkerContent className="flex-1 truncate text-foreground">{row.summary}</MarkerContent>
            {row.failures > 0 ? (
              <span className="shrink-0 text-destructive">{row.failures} failed</span>
            ) : null}
          </button>
        </Marker>
      </CollapsibleTrigger>
      {shown.map((action) => (
        <ActionRow
          key={action.id}
          action={action}
          spinning={streaming && action.id === last.id}
          open={open}
          onToggle={onToggle}
        />
      ))}
    </Collapsible>
  );
});

function LiveRow({ state }: { state: RunState }) {
  const now = useSecond();
  return (
    <Marker>
      <MarkerIcon>
        <Spinner />
      </MarkerIcon>
      <MarkerContent className="flex-1 truncate">{state.text}</MarkerContent>
      <span className="shrink-0 tabular-nums">{elapsed(state.at, now)}</span>
    </Marker>
  );
}

const ClosingRow = memo(function ClosingRow({ text }: { text: string }) {
  return (
    <Marker variant="separator">
      <MarkerContent>{text}</MarkerContent>
    </Marker>
  );
});

/** Work rows sit tight against each other; prose and turns get room to breathe. */
function spacing(row: TranscriptRow): string {
  if (row.kind === "actions" || row.kind === "live") return `pb-0.5 ${ONE_LINE}`;
  if (row.kind === "closing") return `pt-2 pb-0.5 ${ONE_LINE}`;
  return "pb-4";
}

type RowProps = { row: TranscriptRow; live: boolean } & DisclosureProps;

function Row({ row, live, open, onToggle }: RowProps) {
  switch (row.kind) {
    case "input":
      return <InputRow input={row.input} open={open} onToggle={onToggle} />;
    case "line":
      return <LineRow line={row.line} />;
    case "actions":
      return <ActionsRow row={row} live={live} open={open} onToggle={onToggle} />;
    case "live":
      return <LiveRow state={row.state} />;
    case "closing":
      return <ClosingRow text={row.text} />;
  }
}

type RunTranscriptProps = {
  run: Run | undefined;
  sent: OutputLine[];
};

export function RunTranscript({ run, sent }: RunTranscriptProps) {
  const log = useRunLog(run);
  const kept = useRef<{ id: string; rows: TranscriptRow[] }>({ id: "", rows: [] });
  const [expanded, setExpanded] = useState<Record<string, Set<string>>>({});

  const onToggle = useCallback((key: string) => {
    setExpanded((current) => {
      const runId = kept.current.id;
      const showing = new Set(current[runId] ?? []);
      if (!showing.delete(key)) showing.add(key);
      return { ...current, [runId]: showing };
    });
  }, []);

  if (!run) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListTreeIcon />
          </EmptyMedia>
          <EmptyTitle>No run selected</EmptyTitle>
          <EmptyDescription>Pick a run in the sidebar to read its output.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const running = run.status === "running" && run.ask === undefined;
  const tail = run.output.at(-1);
  const acting = running && tail?.type === "action" && tail.status === "running";
  const live = running && !acting ? run.state : undefined;
  const problem = run.problem ?? log;

  const rows = reuseRows(
    kept.current.id === run.id ? kept.current.rows : undefined,
    toRows({ ...run, problem }, sent, live),
  );
  kept.current = { id: run.id, rows };

  if (rows.length === 0 && run.status === "running") {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ActivityIcon />
          </EmptyMedia>
          <EmptyTitle>Running</EmptyTitle>
          <EmptyDescription>No output yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const open = expanded[run.id] ?? NOTHING_OPEN;
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-0 p-4">
            {rows.map((row) => (
              <MessageScrollerItem
                key={`${run.id}-${row.key}`}
                messageId={row.key}
                scrollAnchor={startsTurn(row)}
                className={spacing(row)}
              >
                <div className={COLUMN}>
                  <Row row={row} live={running} open={open} onToggle={onToggle} />
                </div>
              </MessageScrollerItem>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
