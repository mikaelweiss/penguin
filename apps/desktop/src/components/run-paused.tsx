import { PauseIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";

import { pausedReason } from "@/lib/runs";
import type { Paused } from "@/lib/runs";

const TITLES: Record<Paused["by"], string> = {
  user: "You paused this run",
  limit: "The run is waiting on a usage limit",
  error: "The run stopped on an error",
  interrupted: "The run ended before it finished",
};

type RunPausedProps = {
  paused: Paused;
  onResume: () => void;
};

/**
 * A parked run and the way back into it. Only a usage limit clears itself, so a run an
 * error parked sits here until someone starts it again.
 */
export function RunPaused({ paused, onResume }: RunPausedProps) {
  const reason = pausedReason(paused);

  return (
    <div className="shrink-0 border-t p-3">
      <div className="flex flex-col gap-3">
        <Alert>
          <PauseIcon />
          <AlertTitle>{TITLES[paused.by]}</AlertTitle>
          {reason === undefined ? null : <AlertDescription>{reason}</AlertDescription>}
        </Alert>

        <div className="flex items-center gap-3">
          <Button onClick={onResume}>Resume</Button>
          <span className="text-xs text-muted-foreground">
            The run takes up the turn it stopped on.
          </span>
        </div>
      </div>
    </div>
  );
}
