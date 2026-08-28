import type { Tab } from "@/lib/browser";

/**
 * What one pass over the native children should do. Url and title are the address a first look
 * loads; a tab already in `live` is shown where it is.
 */
export function surfacePass({
  live,
  tabs,
  active,
  showing,
}: {
  live: ReadonlySet<string>;
  tabs: readonly Tab[];
  active: string | undefined;
  showing: boolean;
}): {
  close: string[];
  open: { id: string; url: string } | undefined;
  show: string | undefined;
  bounds: string | undefined;
  hide: string[];
} {
  const known = new Set(tabs.map((tab) => tab.id));
  const close: string[] = [];
  const kept: string[] = [];
  for (const id of live) {
    if (known.has(id)) kept.push(id);
    else close.push(id);
  }

  const tab = tabs.find((one) => one.id === active);
  if (!showing || tab === undefined) {
    return { close, open: undefined, show: undefined, bounds: undefined, hide: kept };
  }

  const hide = kept.filter((id) => id !== tab.id);
  if (kept.includes(tab.id)) {
    return { close, open: undefined, show: tab.id, bounds: tab.id, hide };
  }
  return { close, open: { id: tab.id, url: tab.url }, show: undefined, bounds: undefined, hide };
}
