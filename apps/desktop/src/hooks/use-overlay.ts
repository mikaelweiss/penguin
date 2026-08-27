import { useEffect, useState } from "react";

const OPEN = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

/**
 * Whether a modal is up anywhere in the app. The browser panel is a native webview drawn above
 * everything React renders, so it has to hide itself for a dialog to be seen at all.
 *
 * This reads the DOM rather than taking a prop because dialogs are mounted all over the tree, and
 * one added later that nobody remembered to report would render underneath the page.
 */
export function useOverlay(): boolean {
  const [up, setUp] = useState(false);

  useEffect(() => {
    const look = () => setUp(document.querySelector(OPEN) !== null);
    const watching = new MutationObserver(look);
    watching.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
    look();
    return () => watching.disconnect();
  }, []);

  return up;
}
