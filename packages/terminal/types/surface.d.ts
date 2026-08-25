// Hand-written declaration boundary for the vendored terminal. It keeps the
// vendored sources out of importers' typecheck programs; shapes mirror
// src/terminal/ghostty/surface.ts at the commit in ../UPSTREAM.
import type { GhosttyTheme } from "./core";

export declare const DEFAULT_TERMINAL_FONT_SIZE: number;
export declare const DEFAULT_TERMINAL_FONT_FAMILY: string;

/** Requested terminal font; omitted fields fall back to the defaults. */
export interface GhosttyTerminalFont {
  readonly family?: string;
  readonly size?: number;
}

export interface GhosttySelectionPosition {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface GhosttyTerminalSurfaceOptions {
  readonly theme: GhosttyTheme;
  readonly font?: GhosttyTerminalFont;
  readonly onData: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
  readonly onSelectionChange: () => void;
  /** Returns false when the host claims the key, so the terminal skips it. */
  readonly beforeKey: (event: KeyboardEvent) => boolean;
  readonly onLinkActivate: (text: string, event: MouseEvent) => void;
  /** A right-click the running application did not claim through mouse reporting. */
  readonly onContextMenu?: (event: MouseEvent) => void;
}

export declare class GhosttyTerminalSurface {
  readonly canvas: HTMLCanvasElement;
  readonly input: HTMLTextAreaElement;
  readonly scrollbar: HTMLDivElement;
  static create(
    mount: HTMLElement,
    options: GhosttyTerminalSurfaceOptions,
  ): Promise<GhosttyTerminalSurface>;
  write(data: string): void;
  resetAndWrite(data: string): void;
  setTheme(theme: GhosttyTheme): void;
  setFont(font: GhosttyTerminalFont): Promise<void>;
  fit(): boolean;
  focus(): void;
  pasteFromClipboard(readText: () => Promise<string>, isCurrent?: () => boolean): Promise<void>;
  hasSelection(): boolean;
  getSelection(): string;
  getSelectionPosition(): GhosttySelectionPosition | null;
  getSelectionEndClientRect(): { readonly right: number; readonly bottom: number } | null;
  clearSelection(): void;
  scrollToBottom(): void;
  isAtBottom(): boolean;
  dispose(): void;
}
