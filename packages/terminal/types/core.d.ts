// Hand-written declaration boundary for the vendored terminal. It keeps the
// vendored sources out of importers' typecheck programs; shapes mirror
// src/terminal/ghostty/core.ts at the commit in ../UPSTREAM.

export interface GhosttyColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface GhosttyTheme {
  readonly foreground: GhosttyColor;
  readonly background: GhosttyColor;
  readonly cursor: GhosttyColor;
  /** CSS color the renderer overlays on selected cells; not sent to Ghostty. */
  readonly selectionBackground?: string;
}
