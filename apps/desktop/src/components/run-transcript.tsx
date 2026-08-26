import {
  ActivityIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  GlobeIcon,
  ListTreeIcon,
  SearchIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { Markdown } from "@workspace/ui/components/markdown";
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
import type {
  ActionItem,
  ActionKind,
  OutputLine,
  Run,
  RunInput,
  RunState,
  TranscriptItem,
} from "@/lib/runs";

const MARKERS: Record<OutputLine["kind"], string> = {
  show: "",
  ask: "?",
  answer: ">",
  message: ">",
  problem: "!",
};

/** A run reads as a log, so every line is a message with a one-glyph speaker column. */
const LINE = "gap-2 font-mono text-sm/6";

function markerColor(kind: OutputLine["kind"]): string {
  if (kind === "ask") return "text-warning";
  if (kind === "problem") return "text-destructive";
  return "text-muted-foreground";
}

function TranscriptLine({ line }: { line: OutputLine }) {
  return (
    <Message className={LINE}>
      <span aria-hidden="true" className={cn("w-3 shrink-0 select-none", markerColor(line.kind))}>
        {MARKERS[line.kind]}
      </span>
      <MessageContent className={cn("gap-1.5", line.kind === "problem" && "text-destructive")}>
        {line.kind === "show" || line.kind === "ask" ? (
          <Markdown>{line.text}</Markdown>
        ) : (
          <span className="whitespace-pre-wrap">{line.text}</span>
        )}
        {line.attachments ? <AttachmentRow files={line.attachments} /> : null}
      </MessageContent>
    </Message>
  );
}

function ClosingLine({ children }: { children: string }) {
  return (
    <Message className={LINE}>
      <MessageContent className="text-muted-foreground">{children}</MessageContent>
    </Message>
  );
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

function LiveLine({ state }: { state: RunState }) {
  const now = useSecond();
  return (
    <Message className={LINE}>
      <span aria-hidden="true" className="flex w-3 shrink-0 items-center">
        <Spinner className="size-3 text-muted-foreground" />
      </span>
      <MessageContent className="flex-row items-baseline gap-2 text-muted-foreground">
        <span className="min-w-0 truncate">{state.text}</span>
        <span className="shrink-0 tabular-nums">{elapsed(state.at, now)}</span>
      </MessageContent>
    </Message>
  );
}

const ICONS: Record<ActionKind, LucideIcon> = {
  run: SquareTerminalIcon,
  read: EyeIcon,
  edit: SquarePenIcon,
  search: SearchIcon,
  fetch: GlobeIcon,
  agent: BotIcon,
};

function ActionRow({ action, spinning }: { action: ActionItem; spinning: boolean }) {
  const [open, setOpen] = useState(false);
  const Icon = action.kind === undefined ? WrenchIcon : ICONS[action.kind];
  const failed = action.status === "failed";
  const label = (
    <>
      {spinning ? (
        <Spinner className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <Icon
          className={cn("size-3.5 shrink-0", failed ? "text-destructive" : "text-muted-foreground")}
        />
      )}
      <span className={cn("truncate", failed ? "text-destructive" : "text-muted-foreground")}>
        {action.name}
        {action.target === undefined ? null : <span className="ms-2">{action.target}</span>}
      </span>
      {action.output === undefined ? null : (
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      )}
    </>
  );

  return (
    <Message className={LINE}>
      <span aria-hidden="true" className="w-3 shrink-0" />
      <MessageContent className="min-w-0 gap-1">
        {action.output === undefined ? (
          <span className="flex min-w-0 items-center gap-2">{label}</span>
        ) : (
          <button
            type="button"
            className="flex min-w-0 cursor-pointer items-center gap-2 text-start"
            aria-expanded={open}
            onClick={() => setOpen((showing) => !showing)}
          >
            {label}
          </button>
        )}
        {open && action.output !== undefined ? (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap border-s ps-3 text-xs/5 text-muted-foreground">
            {action.output}
          </pre>
        ) : null}
      </MessageContent>
    </Message>
  );
}

/** Contiguous tool calls fold into one summary row; the newest stays visible while it runs. */
function ActionGroup({ actions, live }: { actions: ActionItem[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const last = actions.at(-1);
  if (last === undefined) return null;
  const streaming = live && last.status === "running";

  if (actions.length === 1) return <ActionRow action={last} spinning={streaming} />;

  const failures = actions.filter((action) => action.status === "failed").length;
  const shown = open ? actions : streaming ? [last] : [];
  return (
    <div>
      <Message className={LINE}>
        <span aria-hidden="true" className="w-3 shrink-0" />
        <MessageContent>
          <button
            type="button"
            className="flex cursor-pointer items-center gap-2 text-muted-foreground"
            aria-expanded={open}
            onClick={() => setOpen((showing) => !showing)}
          >
            <ChevronRightIcon
              className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
            />
            <span>{actions.length} actions</span>
            {failures > 0 ? <span className="text-destructive">{failures} failed</span> : null}
          </button>
        </MessageContent>
      </Message>
      {shown.map((action) => (
        <ActionRow
          key={action.id}
          action={action}
          spinning={streaming && action.id === last.id}
        />
      ))}
    </div>
  );
}

const FOLD_LINES = 3;
const FOLD_CHARS = 300;

function folded(value: string): boolean {
  return value.length > FOLD_CHARS || value.split("\n").length > FOLD_LINES;
}

function InputValue({ entry, label }: { entry: RunInput; label: boolean }) {
  const [open, setOpen] = useState(false);
  const name = label ? (
    <span className="text-xs text-muted-foreground">{entry.name}</span>
  ) : null;

  if (!folded(entry.text)) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        {name}
        <span className="whitespace-pre-wrap">{entry.text}</span>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        className="flex min-w-0 cursor-pointer items-center gap-2 text-start"
        aria-expanded={open}
        onClick={() => setOpen((showing) => !showing)}
      >
        <ChevronDownIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
        {name}
        <span className="truncate">{entry.text.split("\n")[0]}</span>
      </button>
      {open ? (
        <div className="max-h-96 overflow-auto whitespace-pre-wrap border-s ps-3 text-muted-foreground">
          {entry.text}
        </div>
      ) : null}
    </div>
  );
}

/** What the run was started with, so the prompt outlives the dialog that sent it. */
function InputBlock({ input }: { input: RunInput[] }) {
  return (
    <Message className={LINE}>
      <span aria-hidden="true" className="w-3 shrink-0 select-none text-muted-foreground">
        {MARKERS.message}
      </span>
      <MessageContent className="gap-2">
        {input.map((entry) => (
          <InputValue key={entry.name} entry={entry} label={input.length > 1} />
        ))}
      </MessageContent>
    </Message>
  );
}

type Block =
  | { type: "line"; line: OutputLine; key: string }
  | { type: "actions"; actions: ActionItem[]; key: string };

function toBlocks(items: TranscriptItem[]): Block[] {
  const blocks: Block[] = [];
  items.forEach((item, index) => {
    if (item.type === "action") {
      const tail = blocks.at(-1);
      if (tail?.type === "actions") {
        tail.actions.push(item);
        return;
      }
      blocks.push({ type: "actions", actions: [item], key: `actions-${item.id}` });
      return;
    }
    blocks.push({ type: "line", line: item.line, key: `line-${index}` });
  });
  return blocks;
}

const CLOSING: Partial<Record<Run["status"], string>> = {
  done: "run finished",
  failed: "run failed",
  stopped: "run stopped",
  crashed: "run crashed",
};

type RunTranscriptProps = {
  run: Run | undefined;
  sent: OutputLine[];
};

export function RunTranscript({ run, sent }: RunTranscriptProps) {
  const log = useRunLog(run);

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

  const closing = CLOSING[run.status];
  const reason = run.problem ?? log;
  const items: TranscriptItem[] = [
    ...run.output,
    ...sent.map((line): TranscriptItem => ({ type: "line", line })),
  ];
  const running = run.status === "running" && run.ask === undefined;
  const tail = items.at(-1);
  const acting = running && tail?.type === "action" && tail.status === "running";
  const live = running && !acting ? run.state : undefined;

  if (
    items.length === 0 &&
    run.input.length === 0 &&
    run.status === "running" &&
    live === undefined
  ) {
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

  const blocks = toBlocks(items);
  return (
    <MessageScrollerProvider>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-0 p-4">
            {run.input.length === 0 ? null : (
              <MessageScrollerItem
                key={`${run.id}-input`}
                className={blocks.length > 0 ? "pb-2" : undefined}
              >
                <InputBlock input={run.input} />
              </MessageScrollerItem>
            )}
            {blocks.map((block, index) => (
              <MessageScrollerItem
                key={`${run.id}-${block.key}`}
                scrollAnchor={live === undefined && index === blocks.length - 1}
              >
                {block.type === "line" ? (
                  <TranscriptLine line={block.line} />
                ) : (
                  <ActionGroup actions={block.actions} live={running} />
                )}
              </MessageScrollerItem>
            ))}
            {closing ? (
              <MessageScrollerItem className="pt-2">
                <ClosingLine>{closing}</ClosingLine>
              </MessageScrollerItem>
            ) : null}
            {reason === undefined ? null : (
              <MessageScrollerItem>
                <TranscriptLine line={{ kind: "problem", text: reason, at: "" }} />
              </MessageScrollerItem>
            )}
            {live === undefined ? null : (
              <MessageScrollerItem scrollAnchor className={blocks.length > 0 ? "pt-2" : undefined}>
                <LiveLine state={live} />
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
