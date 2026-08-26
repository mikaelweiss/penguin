import { useEffect, useState } from "react";
import { FileDiffIcon, SquareTerminalIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@workspace/ui/components/resizable";
import { Separator } from "@workspace/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@workspace/ui/components/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";

import { AppSettingsDialog } from "@/components/app-settings-dialog";
import { CommandPalette } from "@/components/command-palette";
import { DiffPanel } from "@/components/diff-panel";
import { DiffWorkerPool } from "@/components/diff-worker-pool";
import { NewWorkflowDialog } from "@/components/new-workflow-dialog";
import { ProjectSettingsDialog } from "@/components/project-settings-dialog";
import { RunAuth } from "@/components/run-auth";
import { RunBreadcrumb } from "@/components/run-breadcrumb";
import { RunComposer } from "@/components/run-composer";
import { RunSidebar } from "@/components/run-sidebar";
import { RemoveProjectDialog } from "@/components/remove-project-dialog";
import { RunTranscript } from "@/components/run-transcript";
import { TerminalPanel } from "@/components/terminal-panel";
import { useConfig } from "@/hooks/use-config";
import { useDiffView } from "@/hooks/use-diff-view";
import { useDirectories } from "@/hooks/use-directories";
import { useFollow } from "@/hooks/use-follow";
import { useInbox } from "@/hooks/use-inbox";
import { useNeedsYou } from "@/hooks/use-needs-you";
import { PANEL_DEFAULTS, PANEL_MINIMUMS, usePanels } from "@/hooks/use-panels";
import { useRemoveProject } from "@/hooks/use-remove-project";
import { useRunActions } from "@/hooks/use-run-actions";
import { useRuns } from "@/hooks/use-runs";
import { useRunTree } from "@/hooks/use-run-tree";
import { useWindowBackground } from "@/hooks/use-window-background";
import { useWorkflowIndex } from "@/hooks/use-workflow-index";
import { findRun } from "@/lib/runs";
import type { Project } from "@/lib/runs";
import type { Workflow } from "@/lib/workflows";

type Starting = {
  dir: string;
  /** Set when the palette already picked the workflow, so only its params are left. */
  workflow?: Workflow;
};

export function App() {
  useWindowBackground();
  const directories = useDirectories();
  const { projects, published, error } = useRuns(directories.dirs, directories.hidden);
  const removing = useRemoveProject(projects, directories);
  const inbox = useInbox();
  const actions = useRunActions();
  const config = useConfig();
  const tree = useRunTree();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState<Starting | undefined>(undefined);
  const [settingProject, setSettingProject] = useState<Project | undefined>(undefined);
  const [appSettings, setAppSettings] = useState(false);
  const [palette, setPalette] = useState(false);
  const index = useWorkflowIndex(projects, palette);
  const selected = findRun(projects, selectedId);
  const run = selected?.run;
  const panels = usePanels(run?.id);
  const diffView = useDiffView();
  const showTerminal = panels.open("terminal") && run !== undefined;
  const showDiff = panels.open("diff") && run !== undefined;
  const fullTerminal = panels.full === "terminal" && showTerminal;
  const fullDiff = panels.full === "diff" && showDiff;

  const show = (id: string) => {
    const node = findRun(projects, id);
    if (node !== undefined) tree.reveal(node);
    setSelectedId(id);
  };
  const clearFollow = useFollow(projects, selectedId, fullTerminal || fullDiff, show);
  const select = (id: string) => {
    clearFollow();
    show(id);
  };
  useNeedsYou(projects, published, selectedId, select);

  const hasRun = run !== undefined;
  const { toggle } = panels;
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.metaKey && event.key === "/") {
        event.preventDefault();
        if (hasRun) toggle("terminal");
        return;
      }
      if (!event.metaKey) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((showing) => !showing);
      } else if (event.key === ",") {
        event.preventDefault();
        setAppSettings(true);
      }
    };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, [hasRun, toggle]);

  const wrote = run === undefined ? 0 : run.output.length;

  return (
    <TooltipProvider delayDuration={2000} skipDelayDuration={0}>
      <SidebarProvider className="isolate h-svh">
        <RunSidebar
          projects={projects}
          selectedId={selectedId}
          tree={tree}
          actions={actions}
          onSelect={select}
          onNewWorkflow={(dir) => setStarting({ dir })}
          onAddDirectory={directories.add}
          onRemoveDirectory={removing.ask}
          onProjectSettings={setSettingProject}
          onAppSettings={() => setAppSettings(true)}
          onPalette={() => setPalette(true)}
          error={directories.error ?? removing.error}
        />
        <CommandPalette
          open={palette}
          onOpenChange={setPalette}
          projects={projects}
          index={index}
          onSelectRun={select}
          onStartWorkflow={(workflow, dir) => setStarting({ dir, workflow })}
          onAppSettings={() => setAppSettings(true)}
        />
        <ProjectSettingsDialog
          project={settingProject}
          onClose={() => setSettingProject(undefined)}
          onRemove={removing.ask}
        />
        <RemoveProjectDialog
          project={removing.asking}
          onCancel={removing.cancel}
          onHide={removing.hide}
          onDelete={removing.deleteRuns}
        />
        <AppSettingsDialog
          open={appSettings}
          onClose={() => setAppSettings(false)}
          config={config}
          directories={directories}
          onRemoveDirectory={removing.ask}
        />
        <NewWorkflowDialog
          dir={starting?.dir}
          preset={starting?.workflow}
          onClose={() => setStarting(undefined)}
          onStarted={select}
        />
        <SidebarInset className="min-w-0 overflow-hidden">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-4 data-vertical:self-center" />
            {selected ? (
              <RunBreadcrumb node={selected} onSelect={select} />
            ) : (
              <div className="text-sm text-muted-foreground">No run selected</div>
            )}
            {selected ? (
              <div className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground md:block">
                {selected.run.dir}
              </div>
            ) : null}
            <span className="flex-1" />
            <PanelButton
              label="Toggle diff"
              showing={showDiff}
              disabled={run === undefined}
              onClick={() => panels.toggle("diff")}
            >
              <FileDiffIcon />
            </PanelButton>
            <PanelButton
              label="Toggle terminal"
              showing={showTerminal}
              disabled={run === undefined}
              onClick={() => panels.toggle("terminal")}
            >
              <SquareTerminalIcon />
            </PanelButton>
          </header>
          {error ? (
            <Alert variant="destructive" className="m-4 w-auto">
              <TriangleAlertIcon />
              <AlertTitle>Cannot read the run files</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : (
            <ResizablePanelGroup
              orientation="vertical"
              className="min-h-0 flex-1"
              onLayoutChanged={panels.onDragged}
            >
              {fullTerminal ? null : (
                <ResizablePanel
                  key="work"
                  id="work"
                  minSize={PANEL_MINIMUMS.output}
                  className="flex min-h-0 flex-col"
                >
                  <ResizablePanelGroup
                    orientation="horizontal"
                    className="min-h-0 flex-1"
                    onLayoutChanged={panels.onDragged}
                  >
                    {fullDiff ? null : (
                      <ResizablePanel
                        key="output"
                        id="output"
                        minSize={PANEL_MINIMUMS.output}
                        className="flex min-h-0 flex-col"
                      >
                        <RunTranscript
                          run={run}
                          sent={run === undefined ? [] : (inbox.sent[run.id] ?? [])}
                        />
                        {run?.auth !== undefined ? (
                          <RunAuth key={`${run.id}:${run.auth.at}`} auth={run.auth} />
                        ) : run !== undefined && (run.ask !== undefined || run.listening) ? (
                          <RunComposer
                            key={`${run.id}:${run.ask?.prompt ?? ""}`}
                            run={run}
                            error={inbox.error}
                            onSend={(entry, files) => inbox.send(run.id, entry, files)}
                          />
                        ) : null}
                      </ResizablePanel>
                    )}
                    {showDiff && !fullDiff ? <ResizableHandle key="right-handle" /> : null}
                    {showDiff ? (
                      <ResizablePanel
                        key="right"
                        id="right"
                        panelRef={panels.rightRef}
                        defaultSize={PANEL_DEFAULTS.right}
                        minSize={PANEL_MINIMUMS.right}
                        className="flex min-h-0 min-w-0 flex-col"
                      >
                        <DiffWorkerPool>
                          <DiffPanel
                            dir={run.dir}
                            wrote={wrote}
                            view={diffView}
                            full={fullDiff}
                            onToggleFull={() => panels.toggleFull("diff")}
                            onClose={() => panels.close("diff")}
                          />
                        </DiffWorkerPool>
                      </ResizablePanel>
                    ) : null}
                  </ResizablePanelGroup>
                </ResizablePanel>
              )}
              {showTerminal && !fullTerminal ? <ResizableHandle key="work-handle" /> : null}
              {showTerminal ? (
                <ResizablePanel
                  key="terminal"
                  id="terminal"
                  panelRef={panels.terminalRef}
                  defaultSize={PANEL_DEFAULTS.terminal}
                  minSize={PANEL_MINIMUMS.terminal}
                  className="flex min-h-0 flex-col"
                >
                  <TerminalPanel
                    runId={run.id}
                    dir={run.dir}
                    full={fullTerminal}
                    onToggleFull={() => panels.toggleFull("terminal")}
                    onClose={() => panels.close("terminal")}
                  />
                </ResizablePanel>
              ) : null}
            </ResizablePanelGroup>
          )}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

function PanelButton({
  label,
  showing,
  disabled,
  onClick,
  children,
}: {
  label: string;
  showing: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={showing ? "secondary" : "ghost"}
          size="icon-sm"
          aria-label={label}
          aria-pressed={showing}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
