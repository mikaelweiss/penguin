import type { MouseEvent, ReactNode } from "react";
import { FileIcon, PanelLeftIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";

import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@workspace/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";

import { SESSION_OPEN_FILE_TAB } from "@/lib/layout-tabs";
import { fileNameOf, pathFromTab } from "@/lib/file-path";

/** The panels the triggers point at. The strip owns them so the aria wiring stays in one place. */
export const REVIEW_PANEL_ID = "files-panel-review";
export const BROWSER_PANEL_ID = "files-panel-browser";

/** A trigger's id, so the panel it controls can name it back. */
export function tabTriggerId(tab: string): string {
  return `files-panel-tab-${encodeURIComponent(tab)}`;
}

export type FileTabStripProps = {
  /** Rendered left to right after the fixed Review trigger. */
  tabs: string[];
  active: string;
  /** The one italic tab, when there is one. */
  preview: string | undefined;
  /** The count beside the Review label. undefined hides it. */
  reviewCount: number | undefined;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  /** Sidebar toggle is disabled while the browser tab is active. */
  sidebarDisabled: boolean;
  onSelect: (tab: string) => void;
  onPin: (tab: string) => void;
  onClose: (tab: string) => void;
  onOpenBrowser: () => void;
};

const TRIGGER = "h-full flex-none shrink-0 gap-1.5 rounded-none px-2 text-xs";

function IconTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The strip's tabs, the Review trigger apart, each with its close button and middle click. */
function FileTab({
  tab,
  label,
  icon,
  active,
  preview,
  onPin,
  onClose,
}: {
  tab: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  preview: boolean;
  /** Only the preview tab can be pinned, and the browser tab never is. */
  onPin: (() => void) | undefined;
  onClose: () => void;
}) {
  const middleClose = (event: MouseEvent<HTMLElement>) => {
    if (event.button !== 1) return;
    event.preventDefault();
    onClose();
  };

  return (
    <div className="group/tab relative flex h-full shrink-0 items-center">
      <TabsTrigger
        value={tab}
        id={tabTriggerId(tab)}
        aria-controls={active ? BROWSER_PANEL_ID : undefined}
        onDoubleClick={onPin}
        onAuxClick={middleClose}
        className={cn(TRIGGER, "max-w-48 pr-7", preview && "italic")}
      >
        {icon}
        <span className="truncate">{label}</span>
      </TabsTrigger>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Close ${label}`}
        onClick={onClose}
        className={cn(
          "absolute right-1 size-5",
          active ? undefined : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
        )}
      >
        <XIcon />
      </Button>
    </div>
  );
}

/** Review first, then every open file, then the button that opens one more. */
export function FileTabStrip(props: FileTabStripProps) {
  return (
    <Tabs value={props.active} onValueChange={props.onSelect} className="shrink-0 gap-0">
      <TabsList
        variant="line"
        className="h-9 w-full min-w-0 justify-start gap-0 overflow-x-auto rounded-none border-b p-0"
      >
        <div className="sticky left-0 z-10 flex h-full shrink-0 items-center bg-background pr-1">
          <IconTooltip label={props.sidebarOpen ? "Hide the file list" : "Show the file list"}>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={props.sidebarOpen ? "Hide the file list" : "Show the file list"}
              aria-pressed={props.sidebarOpen}
              disabled={props.sidebarDisabled}
              onClick={props.onToggleSidebar}
            >
              <PanelLeftIcon />
            </Button>
          </IconTooltip>
        </div>
        <TabsTrigger
          value="review"
          id={tabTriggerId("review")}
          aria-controls={props.active === "review" ? REVIEW_PANEL_ID : undefined}
          className={TRIGGER}
        >
          Review
          {props.reviewCount === undefined ? null : (
            <Badge variant="secondary" className="tabular-nums">
              {props.reviewCount}
            </Badge>
          )}
        </TabsTrigger>
        {props.tabs.map((tab) => {
          const path = pathFromTab(tab);
          const browser = tab === SESSION_OPEN_FILE_TAB;
          return (
            <FileTab
              key={tab}
              tab={tab}
              label={path === undefined ? "Open file" : fileNameOf(path)}
              icon={browser ? <SearchIcon /> : <FileIcon />}
              active={props.active === tab}
              preview={browser || props.preview === tab}
              onPin={!browser && props.preview === tab ? () => props.onPin(tab) : undefined}
              onClose={() => props.onClose(tab)}
            />
          );
        })}
        <div className="sticky right-0 z-10 ml-auto flex h-full shrink-0 items-center bg-background pl-1">
          <IconTooltip label="Open file">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Open file"
              onClick={props.onOpenBrowser}
            >
              <PlusIcon />
            </Button>
          </IconTooltip>
        </div>
      </TabsList>
    </Tabs>
  );
}
