import { useState } from "react";
import {
  ChevronRightIcon,
  CircleStopIcon,
  CopyIcon,
  FolderIcon,
  FolderPlusIcon,
  FunnelIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@workspace/ui/components/context-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import { Kbd } from "@workspace/ui/components/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";

import { RenameRunDialog } from "@/components/rename-run-dialog";
import { SidebarHandle } from "@/components/sidebar-handle";
import type { RunActions } from "@/hooks/use-run-actions";
import type { RunTree } from "@/hooks/use-run-tree";
import type { SidebarResize } from "@/hooks/use-sidebar-width";
import {
  findBlocked,
  isIdle,
  isLive,
  needsYou,
  resumable,
  unfinished,
  visibleRuns,
} from "@/lib/runs";
import type { Project, Run, RunNode } from "@/lib/runs";

function statusColor(run: Run): string {
  if (needsYou(run)) return "bg-warning";
  if (run.status === "paused") return "border border-warning";
  if (isIdle(run)) return "border border-success";
  if (run.status === "running") return "bg-success animate-pulse";
  if (run.status === "done") return "bg-muted-foreground/40";
  return "bg-destructive";
}

function statusLabel(run: Run): string {
  if (needsYou(run)) return "needs you";
  if (isIdle(run)) return "waiting";
  return run.status;
}

type RunRowProps = {
  node: RunNode;
  selected: boolean;
  collapsed: boolean;
  actions: RunActions;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onRename: (run: Run) => void;
};

function RunRow({
  node,
  selected,
  collapsed,
  actions,
  onSelect,
  onToggle,
  onRename,
}: RunRowProps) {
  const { run, depth } = node;
  const carried = collapsed && !needsYou(run) ? findBlocked(run) : undefined;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SidebarMenuItem
          className="[--run-indent:calc(var(--run-depth)*--spacing(4))]"
          style={{ "--run-depth": depth } as React.CSSProperties}
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2 flex size-4 -translate-y-1/2 items-center justify-center"
          >
            <span className={cn("size-1.5 rounded-full", statusColor(run))} />
          </span>

          <SidebarMenuButton
            size="sm"
            isActive={selected}
            onClick={() => onSelect(run.id)}
            className="gap-0 pl-11"
          >
            <span className="w-(--run-indent) shrink-0" />
            <span className="min-w-0 flex-1 truncate">{run.name}</span>
            <span className="sr-only">{statusLabel(run)}</span>
          </SidebarMenuButton>

          {run.children.length > 0 ? (
            <SidebarMenuAction
              aria-label={`${collapsed ? "Expand" : "Collapse"} ${run.name}`}
              aria-expanded={!collapsed}
              onClick={() => onToggle(run.id)}
              className="right-auto left-5.5 ms-(--run-indent) text-sidebar-foreground/50"
            >
              <ChevronRightIcon className={cn("transition-transform", !collapsed && "rotate-90")} />
            </SidebarMenuAction>
          ) : null}

          {needsYou(run) ? (
            <Badge
              variant="warning"
              aria-label={`needs you: ${run.ask?.prompt ?? run.auth?.reason ?? ""}`}
              className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2"
            >
              needs you
            </Badge>
          ) : null}

          {carried ? (
            <Badge variant="warning" asChild className="absolute top-1/2 right-2 -translate-y-1/2">
              <button
                type="button"
                aria-label={`Show ${carried.blocked.name}, which needs you`}
                onClick={() => onSelect(carried.blocked.id)}
              >
                needs you
                <ChevronRightIcon />
              </button>
            </Badge>
          ) : null}
        </SidebarMenuItem>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!isLive(run)} onSelect={() => actions.pause(run)}>
          <PauseIcon />
          Pause
        </ContextMenuItem>
        <ContextMenuItem disabled={!resumable(run)} onSelect={() => actions.resume(run)}>
          <PlayIcon />
          Resume
        </ContextMenuItem>
        <ContextMenuItem disabled={!unfinished(run)} onSelect={() => actions.stop(run)}>
          <CircleStopIcon />
          Stop
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onRename(run)}>
          <PencilIcon />
          Rename
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.copyDir(run)}>
          <CopyIcon />
          Copy directory
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

type DirectoryRowProps = {
  project: Project;
  showFinished: boolean;
  onToggleFinished: (id: string) => void;
  onNewWorkflow: (dir: string) => void;
  onSettings: (project: Project) => void;
  onRemove: (dir: string) => void;
};

function DirectoryRow({
  project,
  showFinished,
  onToggleFinished,
  onNewWorkflow,
  onSettings,
  onRemove,
}: DirectoryRowProps) {
  const finishedLabel = `${showFinished ? "Hide" : "Show"} finished runs in ${project.name}`;
  const newLabel = `New workflow in ${project.name}`;
  const settingsLabel = `Settings for ${project.name}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <SidebarGroupLabel className="group/dir gap-1.5">
          <FolderIcon />
          <span className="min-w-0 flex-1 truncate">{project.name}</span>
          <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/dir:opacity-100 group-hover/dir:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={finishedLabel}
                  aria-pressed={showFinished}
                  onClick={() => onToggleFinished(project.id)}
                  className={cn(!showFinished && "text-sidebar-foreground/50")}
                >
                  <FunnelIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{finishedLabel}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={newLabel}
                  onClick={() => onNewWorkflow(project.dir)}
                >
                  <PlusIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{newLabel}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={settingsLabel}
                  onClick={() => onSettings(project)}
                >
                  <SettingsIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{settingsLabel}</TooltipContent>
            </Tooltip>
          </span>
        </SidebarGroupLabel>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onNewWorkflow(project.dir)}>
          <PlusIcon />
          New workflow
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onToggleFinished(project.id)}>
          <FunnelIcon />
          {showFinished ? "Hide finished runs" : "Show finished runs"}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => onSettings(project)}>
          <SettingsIcon />
          Project settings
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onRemove(project.dir)}>
          <Trash2Icon />
          Remove directory
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

type RunSidebarProps = {
  projects: Project[];
  selectedId: string | undefined;
  tree: RunTree;
  actions: RunActions;
  onSelect: (id: string) => void;
  onNewWorkflow: (dir: string) => void;
  onAddDirectory: () => void;
  onRemoveDirectory: (dir: string) => void;
  onProjectSettings: (project: Project) => void;
  onAppSettings: () => void;
  onPalette: () => void;
  resize: SidebarResize;
  error: string | undefined;
};

export function RunSidebar({
  projects,
  selectedId,
  tree,
  actions,
  onSelect,
  onNewWorkflow,
  onAddDirectory,
  onRemoveDirectory,
  onProjectSettings,
  onAppSettings,
  onPalette,
  resize,
  error,
}: RunSidebarProps) {
  const [renaming, setRenaming] = useState<Run | undefined>(undefined);

  return (
    <Sidebar>
      <SidebarHeader className="h-12 flex-row items-center justify-between gap-2 px-4">
        <div className="text-sm font-semibold">penguin</div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Add a directory"
              onClick={onAddDirectory}
            >
              <FolderPlusIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Add a directory</TooltipContent>
        </Tooltip>
      </SidebarHeader>
      <SidebarContent>
        {error ? (
          <Alert variant="destructive" className="m-2 w-auto">
            <TriangleAlertIcon />
            <AlertTitle>Cannot save the directory list</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {actions.error ? (
          <Alert variant="destructive" className="m-2 w-auto">
            <TriangleAlertIcon />
            <AlertTitle>Cannot act on the run</AlertTitle>
            <AlertDescription>{actions.error}</AlertDescription>
          </Alert>
        ) : null}
        {projects.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderIcon />
              </EmptyMedia>
              <EmptyTitle>No directories</EmptyTitle>
              <EmptyDescription>Add a project to start a workflow in it.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={onAddDirectory}>
                <FolderPlusIcon data-icon="inline-start" />
                Add a directory
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}
        {projects.map((project) => {
          const showFinished = tree.finished.has(project.id);
          const rows = visibleRuns(project, { collapsed: tree.collapsed, showFinished });

          return (
            <SidebarGroup key={project.id}>
              <DirectoryRow
                project={project}
                showFinished={showFinished}
                onToggleFinished={tree.toggleFinished}
                onNewWorkflow={onNewWorkflow}
                onSettings={onProjectSettings}
                onRemove={onRemoveDirectory}
              />
              <SidebarGroupContent>
                <SidebarMenu>
                  {rows.map((node) => (
                    <RunRow
                      key={node.run.id}
                      node={node}
                      selected={node.run.id === selectedId}
                      collapsed={tree.collapsed.has(node.run.id)}
                      actions={actions}
                      onSelect={onSelect}
                      onToggle={tree.toggleRun}
                      onRename={setRenaming}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter className="flex-row items-center gap-1 border-t">
        <SidebarMenuButton size="sm" onClick={onAppSettings} className="min-w-0 flex-1">
          <SettingsIcon />
          <span className="min-w-0 flex-1 truncate">Settings</span>
        </SidebarMenuButton>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Open the command palette"
              onClick={onPalette}
              className="shrink-0 px-2"
            >
              <Kbd className="bg-transparent">⌘K</Kbd>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open the command palette</TooltipContent>
        </Tooltip>
      </SidebarFooter>
      <RenameRunDialog
        run={renaming}
        onClose={() => setRenaming(undefined)}
        onRename={actions.rename}
      />
      <SidebarHandle resize={resize} />
    </Sidebar>
  );
}
