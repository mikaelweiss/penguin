import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useDark } from "@/hooks/use-dark";

/** Matches `--background` in `packages/ui/src/styles/globals.css`. */
const LIGHT = "#ffffff";
const DARK = "#0a0a0a";

/**
 * Keeps the native window painted in the current theme, and reveals it once it is.
 * The window starts hidden so the strips a resize exposes are never the wrong color.
 */
export function useWindowBackground(): void {
  const dark = useDark();
  const shown = useRef(false);

  useEffect(() => {
    void getCurrentWindow()
      .setBackgroundColor(dark ? DARK : LIGHT)
      .then(() => {
        if (shown.current) return;
        shown.current = true;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            void getCurrentWindow().show();
          });
        });
      });
  }, [dark]);
}
