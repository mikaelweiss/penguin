import { ActivityIcon, ListTreeIcon } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { Message, MessageContent } from "@workspace/ui/components/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@workspace/ui/components/message-scroller";
import { cn } from "@workspace/ui/lib/utils";

import { AttachmentRow } from "@/components/attachment-row";
import { useRunLog } from "@/hooks/use-run-log";
import type { OutputLine, Run } from "@/lib/runs";

const MARKERS: Record<OutputLine["kind"], string> = {
  show: "",
  tool: "",
  waiting: "",
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

function contentStyle(kind: OutputLine["kind"]): string | undefined {
  if (kind === "problem") return "text-destructive";
  if (kind === "tool" || kind === "waiting") return "ps-4 text-muted-foreground";
  return undefined;
}

function TranscriptLine({ line }: { line: OutputLine }) {
  return (
    <Message className={LINE}>
      <span aria-hidden="true" className={cn("w-3 shrink-0 select-none", markerColor(line.kind))}>
        {MARKERS[line.kind]}
      </span>
      <MessageContent className={cn("gap-1.5", contentStyle(line.kind))}>
        <span className="whitespace-pre-wrap">{line.text}</span>
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
  const lines = [...run.output, ...sent];

  if (lines.length === 0 && run.status === "running") {
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

  return (
    <MessageScrollerProvider>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-0 p-4">
            {lines.map((line, index) => (
              <MessageScrollerItem
                key={`${run.id}-${index}`}
                scrollAnchor={index === lines.length - 1}
              >
                <TranscriptLine line={line} />
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
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
