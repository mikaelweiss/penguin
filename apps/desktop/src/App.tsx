import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FilesIcon, GlobeIcon, InfoIcon, SquareTerminalIcon, TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@workspace/ui/components/alert";
import { Button } from "@workspace/ui/components/button";
import { ResizablePanel, ResizablePanelGroup } from "@workspace/ui/components/resizable";
import { Separator } from "@workspace/ui/components/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@workspace/ui/components/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";

import { AppSettingsDialog } from "@/components/app-settings-dialog";
import { BrowserPanel } from "@/components/browser-panel";
import { CommandPalette } from "@/components/command-palette";
import { FilesPanel } from "@/components/files-panel";
import { InfoPanel } from "@/components/info-panel";
import { NewWorkflowDialog } from "@/components/new-workflow-dialog";
import { PANEL_GRAB, PanelHandle } from "@/components/panel-handle";
import { ProjectSettingsDialog } from "@/components/project-settings-dialog";
import { RunAuth } from "@/components/run-auth";
import { RunBreadcrumb } from "@/components/run-breadcrumb";
import { RunComposer } from "@/components/run-composer";
import { RunSidebar } from "@/components/run-sidebar";
import { RemoveProjectDialog } from "@/components/remove-project-dialog";
import { RunTranscript } from "@/components/run-transcript";
import { TerminalPanel } from "@/components/terminal-panel";
import { useBrowser } from "@/hooks/use-browser";
import { useConfig } from "@/hooks/use-config";
import { useDirectories } from "@/hooks/use-directories";
import { useDragKeepsFocus } from "@/hooks/use-drag-keeps-focus";
import { useFollow } from "@/hooks/use-follow";
import { useInbox } from "@/hooks/use-inbox";
import { useNeedsYou } from "@/hooks/use-needs-you";
import { useOverlay } from "@/hooks/use-overlay";
import { PANEL_DEFAULTS, PANEL_MINIMUMS, usePanels } from "@/hooks/use-panels";
import { useRemoveProject } from "@/hooks/use-remove-project";
import { useReviewRoot } from "@/hooks/use-review-root";
import { useRunActions } from "@/hooks/use-run-actions";
import { useRuns } from "@/hooks/use-runs";
import { useRunTree } from "@/hooks/use-run-tree";
import { useSidebarWidth } from "@/hooks/use-sidebar-width";
import { useWatchRoot } from "@/hooks/use-watch-root";
import { useWindowBackground } from "@/hooks/use-window-background";
import { useWorkflowIndex } from "@/hooks/use-workflow-index";
import { autoShows, notificationSound, openIn } from "@/lib/settings";
import { findRun, subtree } from "@/lib/runs";
import type { Project } from "@/lib/runs";
import type { Workflow } from "@/lib/workflows";

type Starting = {
  dir: string;
  /** Set when the palette already picked the workflow, so only its params are left. */
  workflow?: Workflow;
};

export function App() {
  useWindowBackground();
  useDragKeepsFocus();
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
  const sidebar = useSidebarWidth();
  const root = useReviewRoot(run?.dir);
  const browser = useBrowser();
  const overlay = useOverlay();
  useWatchRoot(root?.root);
  const showTerminal = panels.open("terminal") && run !== undefined;
  const showBrowser = panels.open("browser") && run !== undefined;
  const showFiles = panels.open("files") && run !== undefined;
  const showInfo = panels.open("info") && run !== undefined;
  const fullTerminal = panels.full === "terminal" && showTerminal;
  const fullBrowser = panels.full === "browser" && showBrowser;
  const fullFiles = panels.full === "files" && showFiles;
  const fullInfo = panels.full === "info" && showInfo;
  const fullRight = fullBrowser || fullFiles || fullInfo;
  const showRight = showBrowser || showFiles || showInfo;

  const show = (id: string) => {
    const node = findRun(projects, id);
    if (node !== undefined) tree.reveal(node);
    setSelectedId(id);
  };
  const clearFollow = useFollow(projects, selectedId, fullTerminal || fullFiles, show);
  const select = (id: string) => {
    clearFollow();
    show(id);
  };
  const sound = notificationSound(config.values);
  useNeedsYou(projects, published, sound, selectedId, select);

  const into = openIn(config.values);
  const auto = autoShows(config.values);
  const { apply: applyOpens, prune } = browser;
  const { show: showPanel, prune: prunePanels } = panels;
  const opens = run?.opens;
  const openerId = run?.id;
  useEffect(() => {
    if (openerId === undefined || opens === undefined) return;
    const landed = applyOpens(openerId, opens, into);
    if (landed && into === "app" && auto) showPanel("browser");
  }, [openerId, opens, into, auto, applyOpens, showPanel]);

  // Only once the first tree has landed. An empty list before that is the app still reading, and
  // pruning against it would throw away every tab the last session left. A project the user hid or
  // dropped is gone from the tree on purpose, and its tabs go with it.
  useEffect(() => {
    if (!published) return;
    const live = new Set(projects.flatMap((project) => project.runs.flatMap(subtree)));
    prune(live);
    prunePanels(live);
  }, [projects, published, prune, prunePanels]);

  // A link someone clicked is a link they want to see, so it shows the panel whatever the setting
  // for a run's own urls says.
  const followLink = (runId: string, url: string) => {
    if (into === "system") {
      openUrl(url).catch(() => {});
      return;
    }
    browser.open(runId, url);
    showPanel("browser");
  };

  const hasRun = run !== undefined;
  const { toggle, setGlobal } = panels;
  const sidebarOpen = panels.global.sidebarOpen;
  useEffect(() => {
    const open = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.metaKey && event.key === "/") {
        event.preventDefault();
        if (hasRun) toggle("terminal");
        return;
      }
      if (!event.metaKey) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey && key === "r") {
        event.preventDefault();
        if (hasRun) toggle("files");
      } else if (key === "\\") {
        event.preventDefault();
        setGlobal({ sidebarOpen: !sidebarOpen });
      } else if (key === "k") {
        event.preventDefault();
        setPalette((showing) => !showing);
      } else if (event.key === ",") {
        event.preventDefault();
        setAppSettings(true);
      }
    };
    window.addEventListener("keydown", open);
    return () => window.removeEventListener("keydown", open);
  }, [hasRun, toggle, setGlobal, sidebarOpen]);

  return (
    <TooltipProvider delayDuration={2000} skipDelayDuration={0}>
      <SidebarProvider
        className={cn(
          "isolate h-svh",
          // The primitive eases the width open and shut. A drag has to track the pointer instead.
          sidebar.resizing &&
            "[&_[data-slot=sidebar-container]]:transition-none [&_[data-slot=sidebar-gap]]:transition-none",
        )}
        style={sidebar.style}
      >
        <RunSidebar
          resize={sidebar}
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
              label="Toggle info"
              showing={showInfo}
              disabled={run === undefined}
              onClick={() => panels.toggle("info")}
            >
              <InfoIcon />
            </PanelButton>
            <PanelButton
              label="Toggle browser"
              showing={showBrowser}
              disabled={run === undefined}
              onClick={() => panels.toggle("browser")}
            >
              <GlobeIcon />
            </PanelButton>
            <PanelButton
              label="Toggle files"
              showing={showFiles}
              disabled={run === undefined}
              onClick={() => panels.toggle("files")}
            >
              <FilesIcon />
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
              resizeTargetMinimumSize={PANEL_GRAB}
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
                    resizeTargetMinimumSize={PANEL_GRAB}
                    onLayoutChanged={panels.onDragged}
                  >
                    {fullRight ? null : (
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
                    {showRight && !fullRight ? <PanelHandle key="right-handle" /> : null}
                    {showRight ? (
                      <ResizablePanel
                        key="right"
                        id="right"
                        panelRef={panels.rightRef}
                        defaultSize={PANEL_DEFAULTS.right}
                        minSize={PANEL_MINIMUMS.right}
                        className="flex min-h-0 min-w-0 flex-col"
                      >
                        <ResizablePanelGroup
                          orientation="vertical"
                          className="min-h-0 flex-1"
                          resizeTargetMinimumSize={PANEL_GRAB}
                          onLayoutChanged={panels.onDragged}
                        >
                          {showInfo && !fullBrowser && !fullFiles ? (
                            <ResizablePanel
                              key="info"
                              id="info"
                              minSize={PANEL_MINIMUMS.info}
                              className="flex min-h-0 min-w-0 flex-col"
                            >
                              <InfoPanel
                                run={run}
                                root={root}
                                base={panels.base}
                                full={fullInfo}
                                onOpenUrl={(url) => followLink(run.id, url)}
                                onShowFiles={() => panels.show("files")}
                                onToggleFull={() => panels.toggleFull("info")}
                                onClose={() => panels.close("info")}
                              />
                            </ResizablePanel>
                          ) : null}
                          {showInfo && (showBrowser || showFiles) && !fullRight ? (
                            <PanelHandle key="info-handle" />
                          ) : null}
                          {showBrowser && !fullFiles && !fullInfo ? (
                            <ResizablePanel
                              key="browser"
                              id="browser"
                              panelRef={panels.browserRef}
                              defaultSize={PANEL_DEFAULTS.browser}
                              minSize={PANEL_MINIMUMS.browser}
                              className="flex min-h-0 min-w-0 flex-col"
                            >
                              <BrowserPanel
                                held={browser.of(run.id)}
                                all={browser.all}
                                full={fullBrowser}
                                showing={!overlay}
                                onOpen={(url) => browser.open(run.id, url)}
                                onCloseTab={(tabId) => browser.close(run.id, tabId)}
                                onSelect={(tabId) => browser.select(run.id, tabId)}
                                onNewTab={() => browser.newTab(run.id)}
                                onGo={(tabId, url) => browser.go(run.id, tabId, url)}
                                onToggleFull={() => panels.toggleFull("browser")}
                                onClose={() => panels.close("browser")}
                              />
                            </ResizablePanel>
                          ) : null}
                          {showBrowser && showFiles && !fullRight ? (
                            <PanelHandle key="stack-handle" />
                          ) : null}
                          {showFiles && !fullBrowser && !fullInfo ? (
                            <ResizablePanel
                              key="files"
                              id="files"
                              minSize={PANEL_MINIMUMS.files}
                              className="flex min-h-0 min-w-0 flex-col"
                            >
                              <FilesPanel
                                runId={run.id}
                                root={root}
                                panels={panels}
                                full={fullFiles}
                                onToggleFull={() => panels.toggleFull("files")}
                                onClose={() => panels.close("files")}
                              />
                            </ResizablePanel>
                          ) : null}
                        </ResizablePanelGroup>
                      </ResizablePanel>
                    ) : null}
                  </ResizablePanelGroup>
                </ResizablePanel>
              )}
              {showTerminal && !fullTerminal && !fullRight ? (
                <PanelHandle key="work-handle" />
              ) : null}
              {showTerminal && !fullRight ? (
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
                    onOpenUrl={(url) => followLink(run.id, url)}
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
