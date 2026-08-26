import { CodeView } from "@pierre/diffs/react";
import type { ControlledCodeViewProps } from "@pierre/diffs/react";

/**
 * Every surface the renderer paints, remapped onto app tokens. Without it the diff keeps the
 * library's own palette and reads as pasted in. Adapted from t3code's styled viewer.
 */
const DIFF_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: var(--code-background) !important;
  --diffs-light-bg: var(--code-background) !important;
  --diffs-dark-bg: var(--code-background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  /* Gutter, context, and row tints all mix from the code surface itself. Mixing from the page
     canvas instead leaves the gutter looking unthemed wherever the two differ. */
  --diffs-bg-context-override: color-mix(in srgb, var(--code-background) 97%, var(--code-foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--code-background) 94%, var(--code-foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--code-background) 95%, var(--code-foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--code-background) 90%, var(--code-foreground));

  --diffs-bg-addition-override: light-dark(
    color-mix(in srgb, var(--code-background) 50%, var(--success)),
    color-mix(in srgb, var(--code-background) 70%, var(--success))
  );
  --diffs-bg-addition-number-override: light-dark(
    color-mix(in srgb, var(--code-background) 35%, var(--success)),
    color-mix(in srgb, var(--code-background) 60%, var(--success))
  );
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--code-background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--code-background) 80%, var(--success));

  --diffs-bg-deletion-override: light-dark(
    color-mix(in srgb, var(--code-background) 50%, var(--destructive)),
    color-mix(in srgb, var(--code-background) 70%, var(--destructive))
  );
  --diffs-bg-deletion-number-override: light-dark(
    color-mix(in srgb, var(--code-background) 35%, var(--destructive)),
    color-mix(in srgb, var(--code-background) 60%, var(--destructive))
  );
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--code-background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--code-background) 80%, var(--destructive));

  background-color: var(--diffs-bg) !important;
  color: var(--code-foreground) !important;
}

[data-file-info] {
  background-color: var(--code-background) !important;
  border-block-color: transparent !important;
  color: var(--code-foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  align-items: center !important;
  background-color: var(--code-background) !important;
  border-bottom-color: transparent !important;
  font-family: var(--font-sans) !important;
  font-size: 12px !important;
  line-height: 1 !important;
  min-height: 32px !important;
  padding-block: 6px !important;
  padding-inline: 8px 12px !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) {
  height: 24px !important;
  margin-block: 0 !important;
  background-color: var(--code-background) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-separator-wrapper] {
  padding-inline: 8px 12px !important;
  background-color: transparent !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-separator-content] {
  gap: 8px;
  padding-inline: 0 !important;
  background-color: transparent !important;
  color: color-mix(in srgb, var(--code-foreground) 52%, var(--code-background)) !important;
  font-family: var(--font-sans) !important;
  font-size: 11px !important;
  text-decoration: none !important;
}

@media (prefers-reduced-motion: reduce) {
  [data-diff],
  [data-file] {
    transition: none;
  }
}
`;

type Options = NonNullable<ControlledCodeViewProps<undefined>["options"]>;

type DiffCodeViewProps = Omit<ControlledCodeViewProps<undefined>, "options"> & {
  options?: Omit<Options, "unsafeCSS" | "itemMetrics" | "layout">;
};

/** The one adapter around the renderer, so app styling and row geometry stay paired. */
export function DiffCodeView({ options, className, ...props }: DiffCodeViewProps) {
  return (
    <CodeView
      {...props}
      className={`[--code-background:var(--background)] [--code-foreground:var(--foreground)] outline-none ${className ?? ""}`}
      options={{
        ...options,
        unsafeCSS: DIFF_CSS,
        itemMetrics: {
          diffHeaderHeight: 32,
          hunkSeparatorHeight: 24,
          spacing: 0,
          paddingTop: 0,
          // The renderer paints 8px under a file's last line unconditionally, so the metric has
          // to count it. At zero, every expanded file measures short and the list end sits past
          // the reachable scroll range.
          paddingBottom: 8,
        },
        layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
      }}
    />
  );
}
