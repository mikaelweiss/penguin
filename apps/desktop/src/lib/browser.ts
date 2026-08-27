export type Tab = {
  /** Also the native webview's label, so it must stay label-safe: a uuid is. */
  id: string;
  url: string;
  title: string;
};

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

function newTab(url: string): Tab {
  return { id: crypto.randomUUID(), url, title: "" };
}

export function openTab(held: RunTabs, url: string): RunTabs {
  const known = held.tabs.find((tab) => tab.url === url);
  if (known !== undefined) return { ...held, active: known.id };
  const tab = newTab(url);
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

/** What a run's open notes make of its tabs, and whether any of them were news. */
export function applyOpens(held: RunTabs, opens: string[]): { next: RunTabs; opened: boolean } {
  const { urls, applied } = freshOpens(held, opens);
  if (urls.length === 0) return { next: held, opened: false };
  let next = held;
  for (const url of urls) next = openTab(next, url);
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
