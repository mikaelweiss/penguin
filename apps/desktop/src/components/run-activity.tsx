import { useEffect, useState } from "react";
import { ChevronRightIcon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible";
import { Spinner } from "@workspace/ui/components/spinner";
import { cn } from "@workspace/ui/lib/utils";

import type { Run } from "@/lib/runs";

const RECENT = 8;

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

/** The agent's latest action and how long it has been at it, while nothing is waiting on the user. */
export function RunActivity({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const now = useSecond();

  const actions = run.output.filter((line) => line.kind === "tool" || line.kind === "waiting");
  const latest = actions.at(-1);
  if (run.status !== "running" || run.ask !== undefined || latest === undefined) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="shrink-0 border-t px-4 py-2">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start font-mono text-xs">
          <ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
          <Spinner className="size-3" />
          <span className="min-w-0 flex-1 truncate text-left">{latest.text}</span>
          <span className="shrink-0 tabular-nums">{elapsed(latest.at, now)}</span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="ps-6 pt-1">
        {actions.slice(-RECENT).map((line, index) => (
          <div key={index} className="truncate font-mono text-xs/5 text-muted-foreground">
            {line.text}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}
