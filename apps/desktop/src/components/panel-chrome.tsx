import type { ReactNode } from "react";
import { Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";

import { Button } from "@workspace/ui/components/button";

type PanelChromeProps = {
  title: ReactNode;
  name: string;
  full: boolean;
  onToggleFull: () => void;
  onClose: () => void;
  /** Controls that belong to this panel alone, between the title and the window buttons. */
  tools?: ReactNode;
  children: ReactNode;
};

/** The header every panel wears: what it shows, then full screen and close. */
export function PanelChrome({
  title,
  name,
  full,
  onToggleFull,
  onClose,
  tools,
  children,
}: PanelChromeProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/50 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium text-muted-foreground">
          {title}
        </div>
        {tools}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={full ? `Leave full screen` : `Full screen ${name}`}
          onClick={onToggleFull}
        >
          {full ? <Minimize2Icon /> : <Maximize2Icon />}
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label={`Close ${name}`} onClick={onClose}>
          <XIcon />
        </Button>
      </div>
      {children}
    </div>
  );
}
