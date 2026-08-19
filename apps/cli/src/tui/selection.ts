import type { KeyEvent } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { copyText } from "../machine/clipboard.ts";

/**
 * Cmd-C on any screen: the text the mouse selected reaches the clipboard, and the highlight clears.
 * penguin hears the chord because it holds the mouse, so the terminal has no selection of its own.
 */
export function useCopySelection(report?: (note: string) => void): void {
  const renderer = useRenderer();
  useKeyboard((key: KeyEvent) => {
    if (key.super !== true || key.name !== "c") return;
    key.stopPropagation();
    const text = renderer.getSelection()?.getSelectedText() ?? "";
    if (text === "") return;
    renderer.clearSelection();
    void copyText(text).then((done) => {
      if (!("ok" in done)) report?.(done.warn);
    });
  });
}
