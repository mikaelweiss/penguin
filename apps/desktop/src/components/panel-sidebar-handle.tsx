import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

export const PANEL_SIDEBAR = { min: 200, max: 480, default: 240 } as const;

const STEP = 16;

function clamp(width: number): number {
  return Math.min(PANEL_SIDEBAR.max, Math.max(PANEL_SIDEBAR.min, Math.round(width)));
}

/**
 * A panel sidebar's outer edge, dragged to set its width. The width belongs to the panel state, so
 * the handle only reports it. The slot is the panel library's, so a drag here looks like every
 * other. The band reaches barely past the border, because a full screen browser page is a native
 * webview that draws over anything further out.
 */
export function PanelSidebarHandle({
  width,
  onWidth,
}: {
  width: number;
  onWidth: (width: number) => void;
}) {
  const [resizing, setResizing] = useState(false);
  const held = useRef(width);
  held.current = width;
  const dragging = useRef<(() => void) | undefined>(undefined);

  const start = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const fromX = event.clientX;
    const fromWidth = held.current;
    setResizing(true);

    const move = (moved: globalThis.PointerEvent) =>
      onWidth(clamp(fromWidth + moved.clientX - fromX));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      dragging.current = undefined;
      setResizing(false);
    };

    dragging.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  // A panel can close mid drag, and the window listeners outlive the handle that added them.
  useEffect(() => () => dragging.current?.(), []);

  const nudge = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === "ArrowLeft" ? -STEP : event.key === "ArrowRight" ? STEP : 0;
    if (step === 0) return;
    event.preventDefault();
    onWidth(clamp(held.current + step));
  };

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

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the file list"
      aria-valuenow={width}
      aria-valuemin={PANEL_SIDEBAR.min}
      aria-valuemax={PANEL_SIDEBAR.max}
      tabIndex={0}
      data-slot="resizable-handle"
      data-resizing={resizing}
      onPointerDown={start}
      onKeyDown={nudge}
      onDoubleClick={() => onWidth(PANEL_SIDEBAR.default)}
      className="absolute inset-y-0 -right-2 z-20 flex w-4 cursor-col-resize touch-none items-center justify-center after:h-full after:w-1.5 after:rounded-full after:transition-colors hover:after:bg-ring focus-visible:outline-hidden focus-visible:after:bg-ring data-[resizing=true]:after:bg-primary"
    />
  );
}
