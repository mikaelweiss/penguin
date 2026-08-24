import { ListTreeIcon } from "lucide-react";

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
  ask: "?",
  answer: ">",
  message: ">",
  problem: "!",
};

function markerColor(kind: OutputLine["kind"]): string {
  if (kind === "ask") return "text-warning";
  if (kind === "problem") return "text-destructive";
  return "text-muted-foreground";
}

function TranscriptLine({ line }: { line: OutputLine }) {
  return (
    <Message>
      <MessageContent className="gap-1.5 font-mono text-[0.8125rem]/6">
        <div className="flex flex-row gap-2">
          <span className={cn("w-3 shrink-0 select-none", markerColor(line.kind))}>
            {MARKERS[line.kind]}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 whitespace-pre-wrap",
              line.kind === "tool" && "ps-4 text-muted-foreground",
              line.kind === "problem" && "text-destructive",
            )}
          >
            {line.text}
          </span>
        </div>
        {line.attachments ? <AttachmentRow files={line.attachments} className="ms-5" /> : null}
      </MessageContent>
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
              <MessageScrollerItem>
                <div className="pt-2 font-mono text-[0.8125rem]/6 text-muted-foreground">
                  {closing}
                </div>
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
