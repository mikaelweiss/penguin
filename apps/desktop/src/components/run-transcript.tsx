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

import type { OutputLine, Run } from "@/lib/runs";

const MARKERS: Record<OutputLine["kind"], string> = {
  show: "",
  tool: "",
  ask: "?",
  answer: ">",
  message: ">",
};

function markerColor(kind: OutputLine["kind"]): string {
  return kind === "ask" ? "text-warning" : "text-muted-foreground";
}

function TranscriptLine({ line }: { line: OutputLine }) {
  return (
    <Message>
      <MessageContent className="flex-row gap-2 font-mono text-[0.8125rem]/6">
        <span className={cn("w-3 shrink-0 select-none", markerColor(line.kind))}>
          {MARKERS[line.kind]}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 whitespace-pre-wrap",
            line.kind === "tool" && "ps-4 text-muted-foreground",
          )}
        >
          {line.text}
        </span>
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

export function RunTranscript({ run }: { run: Run | undefined }) {
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

  return (
    <MessageScrollerProvider>
      <MessageScroller className="flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="gap-0 p-4">
            {run.output.map((line, index) => (
              <MessageScrollerItem
                key={`${run.id}-${index}`}
                scrollAnchor={index === run.output.length - 1}
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
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
