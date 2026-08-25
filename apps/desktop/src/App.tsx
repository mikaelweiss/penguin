import { useEffect, useState } from "react";
import { SquareTerminalIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@workspace/ui/components/resizable";
import { Separator } from "@workspace/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@workspace/ui/components/sidebar";
import { TooltipProvider } from "@workspace/ui/components/tooltip";

import { AppSettingsDialog } from "@/components/app-settings-dialog";
import { CommandPalette } from "@/components/command-palette";
import { NewWorkflowDialog } from "@/components/new-workflow-dialog";
import { ProjectSettingsDialog } from "@/components/project-settings-dialog";
import { RunActivity } from "@/components/run-activity";
import { RunBreadcrumb } from "@/components/run-breadcrumb";
import { RunComposer } from "@/components/run-composer";
import { RunSidebar } from "@/components/run-sidebar";
import { RunTranscript } from "@/components/run-transcript";
import { TerminalPanel } from "@/components/terminal-panel";
import { useConfig } from "@/hooks/use-config";
import { useDirectories } from "@/hooks/use-directories";
import { useInbox } from "@/hooks/use-inbox";
import { useRunActions } from "@/hooks/use-run-actions";
import { useRuns } from "@/hooks/use-runs";
import { useRunTree } from "@/hooks/use-run-tree";
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
  const directories = useDirectories();
  const { projects, error } = useRuns(directories.dirs);
  const inbox = useInbox();
  const actions = useRunActions();
  const config = useConfig();
  const tree = useRunTree();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState<Starting | undefined>(undefined);
  const [settingProject, setSettingProject] = useState<Project | undefined>(undefined);
  const [appSettings, setAppSettings] = useState(false);
  const [palette, setPalette] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const [terminalFull, setTerminalFull] = useState(false);
  const index = useWorkflowIndex(projects, palette);
  const selected = findRun(projects, selectedId);
  const run = selected?.run;
  const showTerminal = terminal && run !== undefined;
  const fullTerminal = terminalFull && showTerminal;

  const select = (id: string) => {
    const node = findRun(projects, id);
    if (node !== undefined) tree.reveal(node);
    setSelectedId(id);
  };

  const hasRun = run !== undefined;
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.metaKey && event.key === "/") {
        event.preventDefault();
        if (hasRun) {
          setTerminal((showing) => !showing);
          setTerminalFull(false);
        }
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
  }, [hasRun]);

  return (
    <TooltipProvider>
      <SidebarProvider className="isolate h-svh">
        <RunSidebar
          projects={projects}
          selectedId={selectedId}
          tree={tree}
          actions={actions}
          onSelect={select}
          onNewWorkflow={(dir) => setStarting({ dir })}
          onAddDirectory={directories.add}
          onRemoveDirectory={directories.remove}
          onProjectSettings={setSettingProject}
          onAppSettings={() => setAppSettings(true)}
          onPalette={() => setPalette(true)}
          error={directories.error}
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
          onRemove={directories.remove}
        />
        <AppSettingsDialog
          open={appSettings}
          onClose={() => setAppSettings(false)}
          config={config}
          directories={directories}
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
            <Button
              variant={terminal ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label="Toggle terminal"
              aria-pressed={terminal}
              disabled={run === undefined}
              onClick={() => setTerminal((showing) => !showing)}
            >
              <SquareTerminalIcon />
            </Button>
          </header>
          {error ? (
            <Alert variant="destructive" className="m-4 w-auto">
              <TriangleAlertIcon />
              <AlertTitle>Cannot read the run files</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : (
            <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
              {fullTerminal ? null : (
                <ResizablePanel key="output" minSize={160} className="flex min-h-0 flex-col">
                  <RunTranscript
                    run={run}
                    sent={run === undefined ? [] : (inbox.sent[run.id] ?? [])}
                  />
                  {run ? <RunActivity run={run} /> : null}
                  {run !== undefined && (run.ask !== undefined || run.listening) ? (
                    <RunComposer
                      key={`${run.id}:${run.ask?.prompt ?? ""}`}
                      run={run}
                      error={inbox.error}
                      onSend={(entry, files) => inbox.send(run.id, entry, files)}
                    />
                  ) : null}
                </ResizablePanel>
              )}
              {showTerminal && !fullTerminal ? <ResizableHandle key="handle" /> : null}
              {showTerminal ? (
                <ResizablePanel
                  key="terminal"
                  defaultSize={224}
                  minSize={120}
                  className="flex min-h-0 flex-col"
                >
                  <TerminalPanel
                    runId={run.id}
                    dir={run.dir}
                    full={fullTerminal}
                    onToggleFull={() => setTerminalFull((filling) => !filling)}
                    onClose={() => {
                      setTerminal(false);
                      setTerminalFull(false);
                    }}
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
