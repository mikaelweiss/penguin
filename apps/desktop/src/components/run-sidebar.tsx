import { useState } from "react";
import { ChevronRightIcon, FolderIcon, FunnelIcon } from "lucide-react";

import { Badge } from "@workspace/ui/components/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@workspace/ui/components/sidebar";
import { cn } from "@workspace/ui/lib/utils";

import { findBlocked, visibleRuns } from "@/lib/runs";
import type { Project, Run, RunNode } from "@/lib/runs";

function statusColor(run: Run): string {
  if (run.ask) return "bg-warning";
  if (run.status === "running") return "bg-success animate-pulse";
  if (run.status === "done") return "bg-muted-foreground/40";
  return "bg-destructive";
}

function statusLabel(run: Run): string {
  if (run.ask) return "needs you";
  return run.status;
}

type RunRowProps = {
  node: RunNode;
  selected: boolean;
  collapsed: boolean;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  onReveal: (path: { expand: string[]; blocked: Run }) => void;
};

function RunRow({
  node,
  selected,
  collapsed,
  onSelect,
  onToggle,
  onReveal,
}: RunRowProps) {
  const { run, depth } = node;
  const carried = collapsed && !run.ask ? findBlocked(run) : undefined;

  return (
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

      {run.children.length > 0 ? (
        <button
          type="button"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${run.name}`}
          aria-expanded={!collapsed}
          onClick={() => onToggle(run.id)}
          className="absolute top-1/2 left-6 z-10 ms-(--run-indent) -translate-y-1/2 rounded-sm p-0.5 text-sidebar-foreground/50 hover:text-sidebar-foreground"
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")}
          />
        </button>
      ) : null}

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

      {run.ask ? (
        <Badge
          variant="warning"
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
            onClick={() => onReveal(carried)}
          >
            needs you
            <ChevronRightIcon />
          </button>
        </Badge>
      ) : null}
    </SidebarMenuItem>
  );
}

type RunSidebarProps = {
  projects: Project[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
};

export function RunSidebar({ projects, selectedId, onSelect }: RunSidebarProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [finished, setFinished] = useState<ReadonlySet<string>>(new Set());

  const toggleRun = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const toggleFinished = (id: string) =>
    setFinished((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const reveal = ({ expand, blocked }: { expand: string[]; blocked: Run }) => {
    setCollapsed((current) => {
      const next = new Set(current);
      for (const id of expand) next.delete(id);
      return next;
    });
    onSelect(blocked.id);
  };

  return (
    <Sidebar>
      <SidebarHeader className="h-12 justify-center px-4">
        <div className="text-sm font-semibold">penguin</div>
      </SidebarHeader>
      <SidebarContent>
        {projects.map((project) => {
          const showFinished = finished.has(project.id);
          const rows = visibleRuns(project, { collapsed, showFinished });

          return (
            <SidebarGroup key={project.id}>
              <SidebarGroupLabel>
                <FolderIcon />
                <span className="ms-1.5 truncate">{project.name}</span>
              </SidebarGroupLabel>
              <SidebarGroupAction
                aria-label={`${showFinished ? "Hide" : "Show"} finished runs in ${project.name}`}
                aria-pressed={showFinished}
                onClick={() => toggleFinished(project.id)}
                className={cn(!showFinished && "text-sidebar-foreground/50")}
              >
                <FunnelIcon />
              </SidebarGroupAction>
              <SidebarGroupContent>
                <SidebarMenu>
                  {rows.map((node) => (
                    <RunRow
                      key={node.run.id}
                      node={node}
                      selected={node.run.id === selectedId}
                      collapsed={collapsed.has(node.run.id)}
                      onSelect={onSelect}
                      onToggle={toggleRun}
                      onReveal={reveal}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
    </Sidebar>
  );
}

