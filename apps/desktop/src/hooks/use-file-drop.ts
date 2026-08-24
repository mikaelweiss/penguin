import { useEffect, useState } from "react";
import type { RefObject } from "react";
import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWebview } from "@tauri-apps/api/webview";

function over(target: HTMLElement | null, at: PhysicalPosition): boolean {
  if (target === null) return false;
  const point = at.toLogical(window.devicePixelRatio);
  const box = target.getBoundingClientRect();
  return (
    point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom
  );
}

/**
 * Whether a dragged file hovers the target, calling back with the paths when it lands there.
 * The webview hands drags to the window, so a drop is a position to hit test, not a DOM event.
 */
export function useFileDrop(
  target: RefObject<HTMLElement | null>,
  onDrop: (paths: string[]) => void,
): boolean {
  const [hovering, setHovering] = useState(false);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let gone = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const drag = event.payload;
        if (drag.type === "leave") {
          setHovering(false);
          return;
        }
        const inside = over(target.current, drag.position);
        setHovering(inside && drag.type !== "drop");
        if (drag.type === "drop" && inside) onDrop(drag.paths);
      })
      .then((off) => {
        if (gone) off();
        else stop = off;
      });

    return () => {
      gone = true;
      stop?.();
    };
  }, [target, onDrop]);

  return hovering;
}
