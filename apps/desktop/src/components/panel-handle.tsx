import { ResizableHandle } from "@workspace/ui/components/resizable";

/** Grab target around every separator. The library's 10px default is a thin thing to aim at. */
export const PANEL_GRAB = { coarse: 24, fine: 14 } as const;

/**
 * The divider between two panels. Stock shadcn leaves it a hairline that never reacts, so the
 * band lights up under the pointer, while it is dragged, and when a key focuses it.
 */
export function PanelHandle() {
  return (
    <ResizableHandle className="after:w-1.5 after:rounded-full after:transition-colors aria-[orientation=horizontal]:after:h-1.5 focus-visible:after:bg-ring data-[separator=hover]:after:bg-ring data-[separator=active]:after:bg-primary" />
  );
}
