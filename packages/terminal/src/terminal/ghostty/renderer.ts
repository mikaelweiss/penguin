import {
  GHOSTTY_CELL_WIDE,
  ghosttyColorsEqual,
  type GhosttyCell,
  type GhosttyColor,
  type GhosttySnapshot,
} from "./core";

export interface GhosttyCellMetrics {
  readonly width: number;
  readonly height: number;
  readonly baseline: number;
}

export interface GhosttyCellRange {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

const DEFAULT_SELECTION_BACKGROUND = "rgba(72, 122, 191, 0.35)";

function cssColor(color: GhosttyColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

function sameTextStyle(left: GhosttyCell, right: GhosttyCell): boolean {
  // Selection deliberately does not participate: it only tints the background
  // overlay, and splitting a text run at a selection boundary visibly shifts
  // glyph spacing whenever the face's true advance differs from the cell width.
  return (
    ghosttyColorsEqual(left.foreground, right.foreground) &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.invisible === right.invisible
  );
}

export function ghosttyTextRunEnd(
  cells: readonly GhosttyCell[],
  start: number,
  sameStyle: (cell: GhosttyCell) => boolean,
): number {
  let end = start + 1;
  while (end < cells.length) {
    const next = cells[end];
    if (!next) break;
    if (next.wide === GHOSTTY_CELL_WIDE.spacerTail) {
      end += 1;
      continue;
    }
    if (next.text.length === 0 || !sameStyle(next)) break;
    end += 1;
  }
  return end;
}

function fontForCell(cell: GhosttyCell, fontSize: number, fontFamily: string): string {
  const style = cell.italic ? "italic" : "normal";
  const weight = cell.bold ? "700" : "400";
  return `${style} ${weight} ${fontSize}px ${fontFamily}`;
}

/** Fractions of the cell box: left, top, right, bottom. */
type BlockElementRect = readonly [number, number, number, number];

interface BlockElement {
  readonly rects: readonly BlockElementRect[];
  readonly alpha: number;
}

const FULL_CELL: BlockElementRect = [0, 0, 1, 1];

function solid(...rects: readonly BlockElementRect[]): BlockElement {
  return { rects, alpha: 1 };
}

function shade(alpha: number): BlockElement {
  return { rects: [FULL_CELL], alpha };
}

/**
 * U+2580..U+259F as fractions of the cell rather than glyphs. A face draws
 * these on its own em box, which is shorter than a cell at any line height
 * above 1.0, so drawn as text they leave a horizontal seam between every row
 * of block art. Terminals are expected to snap them to the cell instead.
 */
const BLOCK_ELEMENTS: Readonly<Record<string, BlockElement>> = {
  "▀": solid([0, 0, 1, 1 / 2]),
  "▁": solid([0, 7 / 8, 1, 1]),
  "▂": solid([0, 3 / 4, 1, 1]),
  "▃": solid([0, 5 / 8, 1, 1]),
  "▄": solid([0, 1 / 2, 1, 1]),
  "▅": solid([0, 3 / 8, 1, 1]),
  "▆": solid([0, 1 / 4, 1, 1]),
  "▇": solid([0, 1 / 8, 1, 1]),
  "█": solid(FULL_CELL),
  "▉": solid([0, 0, 7 / 8, 1]),
  "▊": solid([0, 0, 3 / 4, 1]),
  "▋": solid([0, 0, 5 / 8, 1]),
  "▌": solid([0, 0, 1 / 2, 1]),
  "▍": solid([0, 0, 3 / 8, 1]),
  "▎": solid([0, 0, 1 / 4, 1]),
  "▏": solid([0, 0, 1 / 8, 1]),
  "▐": solid([1 / 2, 0, 1, 1]),
  "░": shade(0.25),
  "▒": shade(0.5),
  "▓": shade(0.75),
  "▔": solid([0, 0, 1, 1 / 8]),
  "▕": solid([7 / 8, 0, 1, 1]),
  "▖": solid([0, 1 / 2, 1 / 2, 1]),
  "▗": solid([1 / 2, 1 / 2, 1, 1]),
  "▘": solid([0, 0, 1 / 2, 1 / 2]),
  "▙": solid([0, 0, 1 / 2, 1 / 2], [0, 1 / 2, 1, 1]),
  "▚": solid([0, 0, 1 / 2, 1 / 2], [1 / 2, 1 / 2, 1, 1]),
  "▛": solid([0, 0, 1, 1 / 2], [0, 1 / 2, 1 / 2, 1]),
  "▜": solid([0, 0, 1, 1 / 2], [1 / 2, 1 / 2, 1, 1]),
  "▝": solid([1 / 2, 0, 1, 1 / 2]),
  "▞": solid([1 / 2, 0, 1, 1 / 2], [0, 1 / 2, 1 / 2, 1]),
  "▟": solid([1 / 2, 0, 1, 1 / 2], [0, 1 / 2, 1, 1]),
};

export function blockElementForCell(text: string): BlockElement | null {
  return BLOCK_ELEMENTS[text] ?? null;
}

/**
 * Fill one cell's block element. Edges land on whole device pixels so that
 * abutting cells share a boundary exactly; a fractional edge would antialias
 * on both sides and draw the same seam the glyphs do.
 */
export function fillBlockElement(
  context: CanvasRenderingContext2D,
  element: BlockElement,
  color: string,
  left: number,
  top: number,
  metrics: GhosttyCellMetrics,
): void {
  const ratio = context.getTransform().a || 1;
  const snap = (value: number) => Math.round(value * ratio) / ratio;
  context.save();
  context.globalAlpha = element.alpha;
  context.fillStyle = color;
  for (const [x0, y0, x1, y1] of element.rects) {
    const startX = snap(left + x0 * metrics.width);
    const startY = snap(top + y0 * metrics.height);
    const endX = snap(left + x1 * metrics.width);
    const endY = snap(top + y1 * metrics.height);
    context.fillRect(startX, startY, endX - startX, endY - startY);
  }
  context.restore();
}

export function measureGhosttyCell(
  context: CanvasRenderingContext2D,
  fontSize: number,
  fontFamily: string,
): GhosttyCellMetrics {
  context.font = `normal 400 ${fontSize}px ${fontFamily}`;
  const widthMeasurement = context.measureText("M");
  const verticalMeasurement = context.measureText("Mg");
  const ascent = verticalMeasurement.actualBoundingBoxAscent || fontSize;
  const descent = verticalMeasurement.actualBoundingBoxDescent;
  const glyphHeight = ascent + descent;
  const height = Math.max(1, Math.round(fontSize * 1.35), Math.ceil(glyphHeight));
  return {
    width: Math.max(1, widthMeasurement.width),
    height,
    baseline: Math.round((height - glyphHeight) / 2 + ascent),
  };
}

export function terminalGridSize(
  width: number,
  height: number,
  metrics: GhosttyCellMetrics,
  padding: number,
): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.floor((width - padding * 2) / metrics.width)),
    rows: Math.max(1, Math.floor((height - padding * 2) / metrics.height)),
  };
}

export function renderGhosttySnapshot(options: {
  readonly context: CanvasRenderingContext2D;
  readonly snapshot: GhosttySnapshot;
  readonly metrics: GhosttyCellMetrics;
  readonly fontSize: number;
  readonly fontFamily: string;
  readonly padding: number;
  readonly forceFull: boolean;
  readonly cursorOn: boolean;
  readonly previousCursorY?: number | null;
  readonly focused?: boolean;
  readonly selectionBackground?: string;
  readonly hoveredLinkRange?: GhosttyCellRange | null;
  /** Vertical origin of row 0; defaults to the horizontal padding. */
  readonly originY?: number;
}): void {
  const {
    context,
    snapshot,
    metrics,
    fontSize,
    fontFamily,
    padding,
    forceFull,
    cursorOn,
    previousCursorY,
  } = options;
  const focused = options.focused ?? true;
  const selectionBackground = options.selectionBackground ?? DEFAULT_SELECTION_BACKGROUND;
  const hoveredLinkRange = options.hoveredLinkRange ?? null;
  const originY = options.originY ?? padding;
  const rowsToDraw = forceFull
    ? Array.from({ length: snapshot.rows }, (_, index) => index)
    : [...snapshot.dirtyRows];
  if (
    previousCursorY !== null &&
    previousCursorY !== undefined &&
    previousCursorY >= 0 &&
    !rowsToDraw.includes(previousCursorY)
  ) {
    rowsToDraw.push(previousCursorY);
  }
  if (snapshot.cursorVisible && snapshot.cursorY >= 0 && !rowsToDraw.includes(snapshot.cursorY)) {
    rowsToDraw.push(snapshot.cursorY);
  }

  if (forceFull) {
    context.save();
    context.resetTransform();
    context.fillStyle = cssColor(snapshot.background);
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
    context.restore();
  }

  context.textBaseline = "alphabetic";
  for (const rowIndex of rowsToDraw) {
    const row = snapshot.rowData[rowIndex];
    if (!row) continue;
    const top = originY + rowIndex * metrics.height;

    context.fillStyle = cssColor(snapshot.background);
    context.fillRect(padding, top, snapshot.cols * metrics.width, metrics.height);

    let backgroundStart = 0;
    while (backgroundStart < row.cells.length) {
      const first = row.cells[backgroundStart];
      if (!first) break;
      let backgroundEnd = backgroundStart + 1;
      while (backgroundEnd < row.cells.length) {
        const next = row.cells[backgroundEnd];
        if (
          !next ||
          next.selected !== first.selected ||
          !ghosttyColorsEqual(next.background, first.background)
        ) {
          break;
        }
        backgroundEnd += 1;
      }
      if (first.selected || !ghosttyColorsEqual(first.background, snapshot.background)) {
        const left = padding + backgroundStart * metrics.width;
        const width = (backgroundEnd - backgroundStart) * metrics.width;
        if (!ghosttyColorsEqual(first.background, snapshot.background)) {
          context.fillStyle = cssColor(first.background);
          context.fillRect(left, top, width, metrics.height);
        }
        if (first.selected) {
          context.fillStyle = selectionBackground;
          context.fillRect(left, top, width, metrics.height);
        }
      }
      backgroundStart = backgroundEnd;
    }

    let runStart = 0;
    while (runStart < row.cells.length) {
      const first = row.cells[runStart];
      if (!first) break;
      if (first.text.length === 0) {
        runStart += 1;
        continue;
      }
      const block = blockElementForCell(first.text);
      if (block !== null) {
        if (!first.invisible) {
          fillBlockElement(
            context,
            block,
            cssColor(first.foreground),
            padding + runStart * metrics.width,
            top,
            metrics,
          );
        }
        runStart += 1;
        continue;
      }
      const runEnd = ghosttyTextRunEnd(
        row.cells,
        runStart,
        (cell) => blockElementForCell(cell.text) === null && sameTextStyle(cell, first),
      );
      const text = row.cells
        .slice(runStart, runEnd)
        .map((cell) => cell.text)
        .join("");
      if (!first.invisible && text.trim().length > 0) {
        context.save();
        context.beginPath();
        context.rect(
          padding + runStart * metrics.width,
          top,
          (runEnd - runStart) * metrics.width,
          metrics.height,
        );
        context.clip();
        context.font = fontForCell(first, fontSize, fontFamily);
        context.fillStyle = cssColor(first.foreground);
        context.fillText(
          text,
          padding + runStart * metrics.width,
          top + metrics.baseline,
          (runEnd - runStart) * metrics.width,
        );
        context.restore();
      }
      runStart = runEnd;
    }

    for (let column = 0; column < row.cells.length; column += 1) {
      const cell = row.cells[column];
      const hoveredLink =
        hoveredLinkRange !== null &&
        rowIndex >= hoveredLinkRange.start.y &&
        rowIndex <= hoveredLinkRange.end.y &&
        (rowIndex > hoveredLinkRange.start.y || column >= hoveredLinkRange.start.x) &&
        (rowIndex < hoveredLinkRange.end.y || column <= hoveredLinkRange.end.x);
      if (!cell || (!cell.underline && !cell.strikethrough && !cell.overline && !hoveredLink)) {
        continue;
      }
      context.fillStyle = cssColor(cell.foreground);
      const left = padding + column * metrics.width;
      if (cell.underline || hoveredLink) {
        context.fillRect(left, top + metrics.height - 2, metrics.width, 1);
      }
      if (cell.strikethrough) {
        context.fillRect(left, top + Math.floor(metrics.height * 0.55), metrics.width, 1);
      }
      if (cell.overline) context.fillRect(left, top + 1, metrics.width, 1);
    }
  }

  if (cursorOn && snapshot.cursorVisible && snapshot.cursorX >= 0 && snapshot.cursorY >= 0) {
    const left = padding + snapshot.cursorX * metrics.width;
    const top = originY + snapshot.cursorY * metrics.height;
    context.fillStyle = cssColor(snapshot.cursor);
    if (!focused) {
      // An unfocused terminal draws a hollow cursor so the active pane is obvious.
      context.strokeStyle = cssColor(snapshot.cursor);
      context.strokeRect(left + 0.5, top + 0.5, metrics.width - 1, metrics.height - 1);
    } else if (snapshot.cursorStyle === 0) {
      context.fillRect(left, top, 2, metrics.height);
    } else if (snapshot.cursorStyle === 2) {
      context.fillRect(left, top + metrics.height - 2, metrics.width, 2);
    } else if (snapshot.cursorStyle === 3) {
      context.strokeStyle = cssColor(snapshot.cursor);
      context.strokeRect(left + 0.5, top + 0.5, metrics.width - 1, metrics.height - 1);
    } else {
      context.fillRect(left, top, metrics.width, metrics.height);
      const cell = snapshot.rowData[snapshot.cursorY]?.cells[snapshot.cursorX];
      const block = cell ? blockElementForCell(cell.text) : null;
      if (block !== null) {
        fillBlockElement(context, block, cssColor(snapshot.background), left, top, metrics);
      } else if (cell?.text) {
        context.font = fontForCell(cell, fontSize, fontFamily);
        context.fillStyle = cssColor(snapshot.background);
        context.fillText(cell.text, left, top + metrics.baseline, metrics.width);
      }
    }
  }
}
