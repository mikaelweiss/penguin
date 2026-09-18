export type Tab = {
  /** Also the native webview's label, so it must stay label-safe: a uuid is. */
  id: string;
  /** Empty on a tab opened with nowhere to go yet, which is what the landing page is for. */
  url: string;
  title: string;
};

export function isBlank(tab: Tab): boolean {
  return tab.url === "";
}

/**
 * One run's browser. `applied` counts the open notes already landed, so a run you were not
 * watching hands over its backlog once, on the switch, and never again.
 *
 * A count, not a timestamp: a run opening three urls in one tick stamps all three with the same
 * millisecond, and a poll that caught the file between them would lose the rest forever. The run
 * file only ever grows, so how many have been read is the one cursor that cannot slip.
 */
export type RunTabs = {
  tabs: Tab[];
  active: string | undefined;
  applied: number;
};

export const NO_TABS: RunTabs = { tabs: [], active: undefined, applied: 0 };

export type Held = Record<string, RunTabs>;

/** Every tab the app holds. The native pages are the window's, so they are counted together. */
export function allTabs(held: Held): Tab[] {
  return Object.values(held).flatMap((one) => one.tabs);
}

function newTab(url: string): Tab {
  return { id: crypto.randomUUID(), url, title: "" };
}

/** A file served to a page. macOS and Linux get a scheme of their own, Windows a reserved host. */
function isAsset(url: URL): boolean {
  return url.protocol === "asset:" || url.host === "asset.localhost";
}

/** The file on disk behind a url: a brief's own url, or the asset url a page loads it by. */
export function filePath(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return decodeURIComponent(parsed.pathname);
    return isAsset(parsed) ? decodeURIComponent(parsed.pathname.slice(1)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a run's open note loads. A brief is a file, and wry hands a file url straight to the
 * platform's web view, which shows nothing, so it goes through the asset protocol instead. The
 * version the note carries rides along, so a re-render is a page the tab has not seen.
 */
export function pageUrl(url: string, asset: (path: string) => string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol !== "file:") return url;
  return `${asset(decodeURIComponent(parsed.pathname))}${parsed.search}`;
}

/** What the address bar says. A brief reads as the file it is, not as the url serving it. */
export function shownUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!isAsset(parsed)) return url;
    return `file://${decodeURIComponent(parsed.pathname.slice(1))}${parsed.search}`;
  } catch {
    return url;
  }
}

/** One brief re-rendered. The path stays put and only the version on the end of it moves. */
function samePage(a: string, b: string): boolean {
  try {
    const one = new URL(a);
    const two = new URL(b);
    return isAsset(one) && isAsset(two) && one.host === two.host && one.pathname === two.pathname;
  } catch {
    return false;
  }
}

/** The tab a url would land in: the one already holding it, or one waiting to be told where to go. */
export function tabFor(held: RunTabs, url: string): Tab | undefined {
  return (
    held.tabs.find((tab) => tab.url === url) ??
    held.tabs.find((tab) => samePage(tab.url, url)) ??
    held.tabs.find((tab) => tab.id === held.active && isBlank(tab))
  );
}

export function openTab(held: RunTabs, url: string): RunTabs {
  const known = tabFor(held, url);
  if (known === undefined) {
    const tab = newTab(url);
    return { ...held, tabs: [...held.tabs, tab], active: tab.id };
  }
  return { ...navigate(held, known.id, url), active: known.id };
}

/** A tab with nowhere to go yet. One already open is the one you get, rather than a second. */
export function blankTab(held: RunTabs): RunTabs {
  const empty = held.tabs.find(isBlank);
  if (empty !== undefined) return { ...held, active: empty.id };
  const tab = newTab("");
  return { ...held, tabs: [...held.tabs, tab], active: tab.id };
}

export function closeTab(held: RunTabs, id: string): RunTabs {
  const at = held.tabs.findIndex((tab) => tab.id === id);
  if (at === -1) return held;
  const tabs = held.tabs.filter((tab) => tab.id !== id);
  if (held.active !== id) return { ...held, tabs };
  const next = tabs[at] ?? tabs.at(-1);
  return { ...held, tabs, active: next?.id };
}

/** A different page has no name until it says one. The same page keeps the name it gave. */
export function navigate(held: RunTabs, id: string, url: string): RunTabs {
  return {
    ...held,
    tabs: held.tabs.map((tab) =>
      tab.id !== id || tab.url === url ? tab : { ...tab, url, title: "" },
    ),
  };
}

export function retitle(held: RunTabs, id: string, title: string): RunTabs {
  return { ...held, tabs: held.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab)) };
}

/** The opens a run has made since the last ones landed, and the mark that swallows them. */
export function freshOpens(held: RunTabs, opens: string[]): { urls: string[]; applied: number } {
  return { urls: opens.slice(held.applied), applied: opens.length };
}

/** A page a tab was already showing has moved under it, so only the page itself still needs telling. */
export type Moved = { id: string; url: string };

/** Where fresh urls land: the tabs they make, and the tabs they left on a new page. */
export function landOpens(held: RunTabs, urls: string[]): { next: RunTabs; moved: Moved[] } {
  let next = held;
  const moved: Moved[] = [];
  for (const url of urls) {
    const known = tabFor(next, url);
    if (known !== undefined && !isBlank(known) && known.url !== url) {
      moved.push({ id: known.id, url });
    }
    next = openTab(next, url);
  }
  return { next, moved };
}

/** What a run's open notes make of its tabs, and whether any of them were news. */
export function applyOpens(held: RunTabs, opens: string[]): { next: RunTabs; opened: boolean } {
  const { urls, applied } = freshOpens(held, opens);
  if (urls.length === 0) return { next: held, opened: false };
  const { next } = landOpens(held, urls);
  return { next: { ...next, applied }, opened: true };
}

/** A run whose files are gone takes its tabs with it, so the store does not grow forever. */
export function forgetGone(held: Held, live: ReadonlySet<string>): Held {
  const kept = Object.entries(held).filter(([id]) => live.has(id));
  return kept.length === Object.keys(held).length ? held : Object.fromEntries(kept);
}

/** What a person typed in the url field. A bare host is a url they meant, not a search. */
export function typedUrl(typed: string): string | undefined {
  const text = typed.trim();
  if (text === "") return undefined;
  const guess = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(guess);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
