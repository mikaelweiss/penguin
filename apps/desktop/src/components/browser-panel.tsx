import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  PlusIcon,
  RadioTowerIcon,
  RotateCwIcon,
  XIcon,
} from "lucide-react";

import { Button } from "@workspace/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@workspace/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@workspace/ui/components/input-group";
import { Item, ItemContent, ItemGroup, ItemMedia, ItemTitle } from "@workspace/ui/components/item";
import { Spinner } from "@workspace/ui/components/spinner";

import { PanelChrome } from "@/components/panel-chrome";
import { useBrowserSurface } from "@/hooks/use-browser-surface";
import { useLocalServers } from "@/hooks/use-local-servers";
import { allTabs, isBlank, typedUrl, type Held, type RunTabs } from "@/lib/browser";
import {
  browserBack,
  browserForward,
  browserNavigate,
  browserReload,
  onBrowserLoading,
} from "@/lib/webview";

type BrowserPanelProps = {
  held: RunTabs;
  /** Every run's tabs. A page stays open across a run switch, so all of them place it. */
  all: Held;
  full: boolean;
  /** False while a dialog or the palette needs to draw over the page. */
  showing: boolean;
  onOpen: (url: string) => void;
  onCloseTab: (tabId: string) => void;
  onSelect: (tabId: string) => void;
  onNewTab: () => void;
  onGo: (tabId: string, url: string) => void;
  onToggleFull: () => void;
  onClose: () => void;
};

/** What a tab is called before its page says. A url reads better than a placeholder. */
function tabName(url: string, title: string): string {
  if (url === "") return "New tab";
  if (title !== "") return title;
  try {
    const { host, pathname } = new URL(url);
    return pathname === "/" ? host : `${host}${pathname}`;
  } catch {
    return url;
  }
}

export function BrowserPanel({
  held,
  all,
  full,
  showing,
  onOpen,
  onCloseTab,
  onSelect,
  onNewTab,
  onGo,
  onToggleFull,
  onClose,
}: BrowserPanelProps) {
  const mount = useRef<HTMLDivElement>(null);
  const active = held.tabs.find((tab) => tab.id === held.active);
  // A tab with nowhere to go yet has no page to draw, so the landing page keeps the space.
  const showingPage = active !== undefined && !isBlank(active);
  const loading = useLoading(showingPage ? held.active : undefined);
  const surfaceError = useBrowserSurface({
    mount,
    tabs: allTabs(all),
    active: showingPage ? held.active : undefined,
    showing,
  });

  return (
    <PanelChrome
      name="browser"
      full={full}
      onToggleFull={onToggleFull}
      onClose={onClose}
      title={
        <>
          <span className="shrink-0">Browser</span>
          {surfaceError === undefined ? null : (
            <span className="truncate text-destructive">{surfaceError}</span>
          )}
        </>
      }
    >
      {held.tabs.length === 0 ? null : (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1">
          {held.tabs.map((tab) => (
            <div key={tab.id} className="flex shrink-0 items-center">
              <Button
                variant={tab.id === held.active ? "secondary" : "ghost"}
                size="xs"
                aria-current={tab.id === held.active}
                className="max-w-40 justify-start rounded-r-none"
                onClick={() => onSelect(tab.id)}
              >
                <span className="truncate">{tabName(tab.url, tab.title)}</span>
              </Button>
              <Button
                variant={tab.id === held.active ? "secondary" : "ghost"}
                size="icon-xs"
                aria-label={`Close ${tabName(tab.url, tab.title)}`}
                className="rounded-l-none"
                onClick={() => onCloseTab(tab.id)}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      )}

      <UrlRow
        key={active?.id ?? "none"}
        url={active?.url ?? ""}
        tabId={active?.id}
        loading={loading}
        onGo={onGo}
        onOpen={onOpen}
        onNewTab={onNewTab}
      />

      {showingPage ? (
        // A native page draws over the DOM, so it stops short of the resize bands that reach in.
        <div className="flex min-h-0 flex-1 flex-col bg-background pb-[3px] pl-[3px]">
          <div ref={mount} className="min-h-0 flex-1" />
        </div>
      ) : (
        <Landing looking={showing} onOpen={onOpen} />
      )}
    </PanelChrome>
  );
}

/** Whether the tab on screen is still fetching. Its own state: nothing outside the row shows it. */
function useLoading(tabId: string | undefined): boolean {
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(false);
    if (tabId === undefined) return;
    const stopping = onBrowserLoading((which, busy) => {
      if (which === tabId) setLoading(busy);
    });
    return () => {
      stopping.then((stop) => stop()).catch(() => {});
    };
  }, [tabId]);

  return loading;
}

function UrlRow({
  url,
  tabId,
  loading,
  onGo,
  onOpen,
  onNewTab,
}: {
  url: string;
  tabId: string | undefined;
  loading: boolean;
  onGo: (tabId: string, url: string) => void;
  onOpen: (url: string) => void;
  onNewTab: () => void;
}) {
  const [typed, setTyped] = useState(url);
  // The page navigates itself too, so the field follows it except while it is being typed in.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setTyped(url);
  }, [url, editing]);

  // A tab with no page yet has no history to walk and nothing to reload.
  const live = tabId !== undefined && url !== "";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const target = typedUrl(typed);
    if (target === undefined) return;
    setEditing(false);
    if (tabId === undefined) {
      onOpen(target);
      return;
    }
    onGo(tabId, target);
    // A tab with no page yet gets one built at this url. One already showing has to be told.
    if (url !== "") void browserNavigate(tabId, target);
  };

  return (
    <form onSubmit={submit} className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Back"
        disabled={!live}
        onClick={() => tabId !== undefined && void browserBack(tabId)}
        type="button"
      >
        <ArrowLeftIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Forward"
        disabled={!live}
        onClick={() => tabId !== undefined && void browserForward(tabId)}
        type="button"
      >
        <ArrowRightIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Reload"
        disabled={!live}
        onClick={() => tabId !== undefined && void browserReload(tabId)}
        type="button"
      >
        {loading ? <Spinner /> : <RotateCwIcon />}
      </Button>
      <InputGroup className="h-7 min-w-0 flex-1">
        <InputGroupInput
          aria-label="Address"
          placeholder="Type a url"
          value={typed}
          onChange={(event) => {
            setEditing(true);
            setTyped(event.target.value);
          }}
          onBlur={() => setEditing(false)}
          className="font-mono text-xs"
        />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            aria-label="Open in the default browser"
            disabled={url === ""}
            onClick={() => void openUrl(url)}
            type="button"
          >
            <ExternalLinkIcon />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="New tab"
        onClick={onNewTab}
        type="button"
      >
        <PlusIcon />
      </Button>
    </form>
  );
}

/** What the panel shows before it holds a page: the dev servers running right now. */
function Landing({ looking, onOpen }: { looking: boolean; onOpen: (url: string) => void }) {
  const servers = useLocalServers(looking);

  if (servers.length === 0) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GlobeIcon />
          </EmptyMedia>
          <EmptyTitle>No page open</EmptyTitle>
          <EmptyDescription>
            Type a url above, or start a dev server and it shows up here.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <RadioTowerIcon className="size-4" />
        Local servers
      </div>
      <ItemGroup className="gap-0">
        {servers.map((server) => (
          <Item key={server.port} size="sm" asChild className="px-0">
            <button type="button" onClick={() => onOpen(server.url)}>
              <ItemMedia variant="icon">
                <GlobeIcon />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{server.process ?? "Listening"}</ItemTitle>
              </ItemContent>
              <span className="font-mono text-xs text-muted-foreground">localhost:{server.port}</span>
            </button>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
}
