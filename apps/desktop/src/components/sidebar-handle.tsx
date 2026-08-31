import { SIDEBAR_WIDTH } from "@/hooks/use-sidebar-width";
import type { SidebarResize } from "@/hooks/use-sidebar-width";

/**
 * The sidebar's outer edge, dragged to set its width. shadcn's rail only toggles the sidebar, so
 * the separator, its grab band, and the arrow keys are ours. The slot is the panel library's, so
 * a drag here gives the keyboard back the way every other drag does. The band reaches barely
 * past the border, because a full screen browser page is a native webview that draws over
 * anything further out.
 */
export function SidebarHandle({ resize }: { resize: SidebarResize }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the sidebar"
      aria-valuenow={resize.width}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      tabIndex={0}
      data-slot="resizable-handle"
      data-resizing={resize.resizing}
      onPointerDown={resize.start}
      onKeyDown={resize.nudge}
      onDoubleClick={resize.reset}
      className="absolute inset-y-0 -right-2 z-20 hidden w-4 cursor-col-resize touch-none items-center justify-center after:h-full after:w-1.5 after:rounded-full after:transition-colors group-data-[collapsible=offcanvas]:hidden hover:after:bg-ring focus-visible:outline-hidden focus-visible:after:bg-ring data-[resizing=true]:after:bg-primary md:flex"
    />
  );
}
