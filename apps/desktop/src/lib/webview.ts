import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { Held } from "@/lib/browser";

/** Rust knows a tab by this. It matches what the startup sweep looks for. */
export function labelOf(tabId: string): string {
  return `browser:${tabId}`;
}

export type Rect = { x: number; y: number; width: number; height: number };

/**
 * The tabs the window is holding a page for. One window holds one set of them, whichever run is
 * on screen, so it outlives every panel that draws them: a panel that is gone still has pages to
 * answer for, and a page kept alive is a page that does not reload when you come back to it.
 */
const live = new Set<string>();

export function liveTabs(): ReadonlySet<string> {
  return live;
}

/** A page that will not answer is no longer held, whatever the window still thinks. */
export function forgetTab(tabId: string): void {
  live.delete(tabId);
}

/**
 * A rect plus the viewport it was measured in. Rust places a page against the window's content
 * area, which on macOS can reach up under the title bar; comparing the two heights is what tells
 * it how far apart the two are, without either side hard-coding a title bar.
 */
function bounds(rect: Rect): Rect & { viewport: number } {
  return { ...rect, viewport: window.innerHeight };
}

/**
 * Closes every page the window still holds. A reloaded frontend has forgotten the tabs it opened,
 * and nothing else can reach them, so this runs before the first tab of a session.
 */
export function browserReset(): Promise<void> {
  live.clear();
  return invoke("browser_reset");
}

export function browserOpen(tabId: string, url: string, rect: Rect): Promise<void> {
  live.add(tabId);
  return invoke<void>("browser_open", { label: labelOf(tabId), url, at: bounds(rect) }).catch(
    (cause: unknown) => {
      live.delete(tabId);
      throw cause;
    },
  );
}

export function browserBounds(tabId: string, rect: Rect): Promise<void> {
  return invoke("browser_bounds", { label: labelOf(tabId), at: bounds(rect) });
}

export function browserShow(tabId: string): Promise<void> {
  return invoke("browser_show", { label: labelOf(tabId) });
}

export function browserHide(tabId: string): Promise<void> {
  return invoke("browser_hide", { label: labelOf(tabId) });
}

export function browserClose(tabId: string): Promise<void> {
  live.delete(tabId);
  return invoke("browser_close", { label: labelOf(tabId) });
}

export function browserNavigate(tabId: string, url: string): Promise<void> {
  return invoke("browser_navigate", { label: labelOf(tabId), url });
}

export function browserReload(tabId: string): Promise<void> {
  return invoke("browser_reload", { label: labelOf(tabId) });
}

export function browserBack(tabId: string): Promise<void> {
  return invoke("browser_back", { label: labelOf(tabId) });
}

export function browserForward(tabId: string): Promise<void> {
  return invoke("browser_forward", { label: labelOf(tabId) });
}

type Said<T> = { label: string; said: T };

function onBrowser<T>(event: string, handle: (tabId: string, said: T) => void): Promise<UnlistenFn> {
  return listen<Said<T>>(event, ({ payload }) => {
    handle(payload.label.replace(/^browser:/, ""), payload.said);
  });
}

/** Where a tab went, whether the panel sent it or the page did. */
export function onBrowserUrl(handle: (tabId: string, url: string) => void): Promise<UnlistenFn> {
  return onBrowser("browser-url", handle);
}

export function onBrowserTitle(handle: (tabId: string, title: string) => void): Promise<UnlistenFn> {
  return onBrowser("browser-title", handle);
}

export function onBrowserLoading(
  handle: (tabId: string, loading: boolean) => void,
): Promise<UnlistenFn> {
  return onBrowser("browser-loading", handle);
}

/** A page the tab asked to open in a window of its own. The panel makes it a tab instead. */
export function onBrowserPopup(handle: (tabId: string, url: string) => void): Promise<UnlistenFn> {
  return onBrowser("browser-popup", handle);
}

/** Each run's tabs, kept in the app's own config so a quit does not lose them. */
export function readBrowser(): Promise<Held> {
  return invoke<Held>("read_browser");
}

export function writeBrowser(tabs: Held): Promise<void> {
  return invoke("write_browser", { tabs });
}
