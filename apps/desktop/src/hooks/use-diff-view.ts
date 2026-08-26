import { useCallback, useState } from "react";

export type DiffView = {
  /** Side by side rather than one column. */
  split: boolean;
  /** Long lines roll onto the next row rather than scrolling sideways. */
  wrap: boolean;
  /** Lines that differ only in spacing stay out of the patch. */
  ignoreWhitespace: boolean;
};

export type DiffViewState = DiffView & { set: (edit: Partial<DiffView>) => void };

const START: DiffView = { split: false, wrap: false, ignoreWhitespace: false };

/**
 * How the diff is drawn, which is a preference rather than a property of a run. It outlives
 * closing the panel and switching runs, unlike what each run has open.
 */
export function useDiffView(): DiffViewState {
  const [view, setView] = useState<DiffView>(START);
  const set = useCallback((edit: Partial<DiffView>) => setView((held) => ({ ...held, ...edit })), []);
  return { ...view, set };
}
