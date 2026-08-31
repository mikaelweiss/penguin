import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { browserFocus, pageOnScreen } from "@/lib/webview";

function handleAt(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof HTMLElement)) return null;
  return node.closest('[data-slot="resizable-handle"]');
}

/**
 * Hands the keyboard back to whatever held it once a panel drag ends.
 *
 * A drag changes panel sizes and nothing else, but two things take focus on the way: the panel
 * library focuses the separator on pointer down, and pressing anywhere in the window's own webview
 * takes the keyboard from a browser page. So the caret leaves the terminal, the composer, or the
 * page for a resize that never asked for it.
 */
export function useDragKeepsFocus(): void {
  useEffect(() => {
    let displaced: HTMLElement | undefined;
    let page: string | undefined;
    let pressing = false;

    const press = () => {
      pressing = true;
    };

    const moved = (event: FocusEvent) => {
      if (handleAt(event.target) !== null) {
        const from = event.relatedTarget;
        displaced =
          pressing && from instanceof HTMLElement && from !== document.body ? from : undefined;
        return;
      }
      displaced = undefined;
      page = undefined;
    };

    // A page takes the keyboard without the frontend hearing anything but this blur. Going to the
    // background blurs the window too, so only a window that stays keyed has handed it to a page.
    const lost = () => {
      const shown = pageOnScreen();
      if (shown === undefined) return;
      void getCurrentWindow()
        .isFocused()
        .then((keyed) => {
          if (keyed) page = shown;
        });
    };

    // The separator holds focus only when the press that just ended was a drag: the library's grab
    // region reaches past the separator itself, so where the pointer went down proves nothing.
    const release = () => {
      pressing = false;
      const bar = handleAt(document.activeElement);
      if (bar === null) {
        page = undefined;
        return;
      }
      if (page !== undefined) {
        bar.blur();
        browserFocus(page).catch(() => {});
        return;
      }
      displaced?.focus({ preventScroll: true });
    };

    window.addEventListener("pointerdown", press, true);
    window.addEventListener("focusin", moved);
    window.addEventListener("blur", lost);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("focusin", moved);
      window.removeEventListener("blur", lost);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);
}
