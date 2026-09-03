import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@workspace/ui/components/badge";
import { cn } from "@workspace/ui/lib/utils";

import { DiffWorkerPool } from "@/components/diff-worker-pool";
import { FileBrowserTab } from "@/components/file-browser-tab";
import {
  BROWSER_PANEL_ID,
  FileTabStrip,
  REVIEW_PANEL_ID,
  tabTriggerId,
} from "@/components/file-tab-strip";
import { PanelChrome } from "@/components/panel-chrome";
import { ReviewTab } from "@/components/review-tab";
import type { PanelState } from "@/hooks/use-panels";
import { useReview } from "@/hooks/use-review";
import { fileTab, pathFromTab } from "@/lib/file-path";
import type { ReviewRoot } from "@/lib/files";
import {
  closeSessionTab,
  openSessionTab,
  previewSessionTab,
  SESSION_OPEN_FILE_TAB,
  type SessionTabState,
} from "@/lib/layout-tabs";

const REVIEW_TAB = "review";

export type FilesPanelProps = {
  runId: string;
  /** undefined until review_root has answered for this run. */
  root: ReviewRoot | undefined;
  panels: PanelState;
  full: boolean;
  onToggleFull: () => void;
  onClose: () => void;
};

/** Two tabs for the same path are one tab, whatever spelling either arrived in. */
function normalize(tab: string): string {
  const path = pathFromTab(tab);
  return path === undefined ? tab : fileTab(path);
}

/** What the strip shows: every open tab, the Review trigger apart, deduped by path. */
function panelTabsOf(state: SessionTabState): string[] {
  const seen = new Set<string>();
  const shown: string[] = [];
  for (const tab of state.tabs.all) {
    if (tab === REVIEW_TAB) continue;
    const value = normalize(tab);
    if (seen.has(value)) continue;
    seen.add(value);
    shown.push(value);
  }
  return shown;
}

/** The Review tab, one tab per open file, and the browser that opens the next one. */
export function FilesPanel({
  runId,
  root,
  panels,
  full,
  onToggleFull,
  onClose,
}: FilesPanelProps) {
  const review = useReview(root?.root, panels.base);
  const filter = useRef<HTMLInputElement | null>(null);
  const [reviewFile, setReviewFile] = useState<string | undefined>(undefined);
  // The review's file belongs to the run that picked it, and no other.
  const picked = useRef(runId);
  if (picked.current !== runId) {
    picked.current = runId;
    setReviewFile(undefined);
  }

  const state = panels.tabs;
  const { setTabs, setGlobal } = panels;
  const tabs = useMemo(() => panelTabsOf(state), [state]);
  const opened = useMemo(
    () => tabs.filter((tab) => tab !== SESSION_OPEN_FILE_TAB),
    [tabs],
  );

  const chosen = state.tabs.active;
  const active =
    chosen === REVIEW_TAB
      ? REVIEW_TAB
      : chosen === SESSION_OPEN_FILE_TAB && tabs.includes(chosen)
        ? chosen
        : chosen !== undefined &&
            pathFromTab(chosen) !== undefined &&
            tabs.includes(normalize(chosen))
          ? normalize(chosen)
          : (opened[0] ?? REVIEW_TAB);

  const select = useCallback(
    (tab: string) => setTabs({ ...state, tabs: { ...state.tabs, active: normalize(tab) } }),
    [setTabs, state],
  );
  const pin = useCallback(
    (tab: string) => setTabs(openSessionTab(state, normalize(tab))),
    [setTabs, state],
  );
  const close = useCallback(
    (tab: string) => setTabs(closeSessionTab(state, normalize(tab))),
    [setTabs, state],
  );
  const preview = useCallback(
    (tab: string) => setTabs(previewSessionTab(state, normalize(tab))),
    [setTabs, state],
  );

  const openBrowser = useCallback(() => {
    preview(SESSION_OPEN_FILE_TAB);
    queueMicrotask(() => filter.current?.focus());
  }, [preview]);

  const closable =
    active === SESSION_OPEN_FILE_TAB || opened.includes(active) ? active : undefined;

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const pressed = event.key.toLowerCase();
      if (pressed === "p") {
        event.preventDefault();
        openBrowser();
        return;
      }
      if (pressed === "w" && closable !== undefined) {
        event.preventDefault();
        close(closable);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [openBrowser, close, closable]);

  const fileTabActive = opened.includes(active) ? active : undefined;
  const shown =
    active === SESSION_OPEN_FILE_TAB
      ? SESSION_OPEN_FILE_TAB
      : (fileTabActive ?? SESSION_OPEN_FILE_TAB);
  // The browser keeps its tree and its scroll while another tab is in front, so it hides
  // rather than unmounts.
  const mounted = tabs.length > 0;
  const visible = active !== REVIEW_TAB;
  const labelled = tabs.includes(shown) ? tabTriggerId(shown) : undefined;

  return (
    <PanelChrome
      name="files"
      full={full}
      onToggleFull={onToggleFull}
      onClose={onClose}
      title={
        <>
          <span className="shrink-0">Files</span>
          {review.base === "" ? null : (
            <Badge variant="secondary" className="min-w-0 shrink">
              <span className="truncate">against {review.base}</span>
            </Badge>
          )}
        </>
      }
    >
      <DiffWorkerPool>
        <div className="flex min-h-0 flex-1 flex-col">
          <FileTabStrip
            tabs={tabs}
            active={active}
            preview={state.preview}
            reviewCount={review.ready && review.git ? review.stat.files : undefined}
            sidebarOpen={panels.global.sidebarOpen}
            onToggleSidebar={() => setGlobal({ sidebarOpen: !panels.global.sidebarOpen })}
            sidebarDisabled={active === SESSION_OPEN_FILE_TAB}
            onSelect={select}
            onPin={pin}
            onClose={close}
            onOpenBrowser={openBrowser}
          />
          {active === REVIEW_TAB ? (
            <div
              id={REVIEW_PANEL_ID}
              role="tabpanel"
              aria-labelledby={tabTriggerId(REVIEW_TAB)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <ReviewTab
                root={root}
                base={panels.base}
                onBaseChange={panels.setBase}
                review={review}
                sidebarOpen={panels.global.sidebarOpen}
                sidebarWidth={panels.global.sidebarWidth}
                onSidebarWidth={(width) => setGlobal({ sidebarWidth: width })}
                diffStyle={panels.global.diffStyle}
                onDiffStyle={(style) => setGlobal({ diffStyle: style })}
                expandMode={panels.global.expandMode}
                onExpandMode={(mode) => setGlobal({ expandMode: mode })}
                activeFile={reviewFile}
                onSelectFile={setReviewFile}
              />
            </div>
          ) : null}
          {mounted ? (
            <div
              id={BROWSER_PANEL_ID}
              role="tabpanel"
              aria-labelledby={labelled}
              aria-label={labelled === undefined ? "Files" : undefined}
              inert={!visible}
              className={cn("flex min-h-0 flex-1 flex-col", !visible && "hidden")}
            >
              <FileBrowserTab
                root={root}
                placeholder={shown === SESSION_OPEN_FILE_TAB}
                tab={shown}
                active={pathFromTab(shown)}
                changes={review.files}
                sidebarOpen={panels.global.sidebarOpen}
                sidebarWidth={panels.global.sidebarWidth}
                onSidebarWidth={(width) => setGlobal({ sidebarWidth: width })}
                onSelect={(path) => preview(fileTab(path))}
                onSelectPermanent={(path) => pin(fileTab(path))}
                filterRef={(element) => {
                  filter.current = element;
                }}
              />
            </div>
          ) : null}
        </div>
      </DiffWorkerPool>
    </PanelChrome>
  );
}
