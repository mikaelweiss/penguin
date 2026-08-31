import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";

const STORE = "sidebar-width";
const STEP = 16;

export const SIDEBAR_WIDTH = { min: 180, max: 520, default: 256 } as const;

function clamp(width: number): number {
  return Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(width)));
}

function stored(): number {
  const saved = Number(localStorage.getItem(STORE));
  return Number.isFinite(saved) && saved > 0 ? clamp(saved) : SIDEBAR_WIDTH.default;
}

export type SidebarResize = {
  width: number;
  resizing: boolean;
  /** Feed to SidebarProvider. The primitive reads the sidebar's width from this variable. */
  style: CSSProperties;
  start: (event: PointerEvent<HTMLElement>) => void;
  nudge: (event: KeyboardEvent<HTMLElement>) => void;
  reset: () => void;
};

/** How wide the run sidebar is, dragged by its edge and kept across launches. */
export function useSidebarWidth(): SidebarResize {
  const [width, setWidth] = useState(stored);
  const [resizing, setResizing] = useState(false);
  const held = useRef(width);

  const apply = useCallback((next: number) => {
    held.current = clamp(next);
    setWidth(held.current);
  }, []);

  const save = useCallback(() => {
    localStorage.setItem(STORE, String(held.current));
  }, []);

  const start = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const fromX = event.clientX;
      const fromWidth = held.current;
      setResizing(true);

      const move = (moved: globalThis.PointerEvent) => apply(fromWidth + moved.clientX - fromX);
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        setResizing(false);
        save();
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [apply, save],
  );

  const nudge = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const step = event.key === "ArrowLeft" ? -STEP : event.key === "ArrowRight" ? STEP : 0;
      if (step === 0) return;
      event.preventDefault();
      apply(held.current + step);
      save();
    },
    [apply, save],
  );

  const reset = useCallback(() => {
    apply(SIDEBAR_WIDTH.default);
    save();
  }, [apply, save]);

  // The pointer leaves the handle the moment the drag outruns it, so the cursor belongs to the
  // whole window until the drag ends.
  useEffect(() => {
    if (!resizing) return;
    const style = document.body.style;
    style.cursor = "col-resize";
    style.userSelect = "none";
    return () => {
      style.cursor = "";
      style.userSelect = "";
    };
  }, [resizing]);

  return {
    width,
    resizing,
    style: { "--sidebar-width": `${width}px` } as CSSProperties,
    start,
    nudge,
    reset,
  };
}
