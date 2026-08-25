import type { GhosttyColor, GhosttyTheme } from "@workspace/terminal/core";

let probe: CanvasRenderingContext2D | null | undefined;

/** Resolves any CSS color, oklch tokens included, by drawing one pixel and reading it back. */
function sample(css: string): GhosttyColor | undefined {
  const value = css.trim();
  if (value === "") return undefined;
  if (probe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    probe = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (probe === null) return undefined;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "rgba(0, 0, 0, 0)";
  probe.fillStyle = value;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  if (a === 0) return undefined;
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
}

/** The terminal drawn in the app's own tokens, resolved at call time. */
export function terminalTheme(): GhosttyTheme {
  const styles = getComputedStyle(document.documentElement);
  const dark = document.documentElement.classList.contains("dark");
  const token = (name: string) => sample(styles.getPropertyValue(name));
  const foreground = token("--foreground") ?? (dark ? { r: 250, g: 250, b: 250 } : { r: 23, g: 23, b: 23 });
  const background = token("--background") ?? (dark ? { r: 23, g: 23, b: 23 } : { r: 255, g: 255, b: 255 });
  const cursor = token("--primary") ?? foreground;
  return {
    foreground,
    background,
    cursor,
    selectionBackground: `rgba(${cursor.r}, ${cursor.g}, ${cursor.b}, ${dark ? 0.35 : 0.25})`,
  };
}
