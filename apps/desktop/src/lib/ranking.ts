import { defaultFilter } from "cmdk";

/** What a search matches a command row on. A disabled row is one nothing can start. */
export type Row = { value: string; disabled?: boolean };

/** The rows under one heading, in the order they were declared. */
export type Band<R extends Row> = { title: string; rows: R[] };

export type Ranking<R extends Row> = {
  bands: Band<R>[];
  /** The row the cursor belongs on, so Enter starts what was searched for. */
  top: string | undefined;
};

/**
 * What a search leaves of the bands: the rows it matches, best first, the band holding the best
 * row leading. An empty search keeps every row where it was declared.
 */
export function ranked<R extends Row>(bands: Band<R>[], search: string): Ranking<R> {
  const kept = search === "" ? bands : matching(bands, search);
  const first = kept.flatMap((band) => band.rows).find((row) => row.disabled !== true);
  return { bands: kept, top: first?.value };
}

function matching<R extends Row>(bands: Band<R>[], search: string): Band<R>[] {
  return bands
    .map((band) => {
      const hits = band.rows
        .map((row) => ({ row, score: defaultFilter(row.value, search) }))
        .filter((hit) => hit.score > 0)
        .sort((one, other) => other.score - one.score);
      return { band: { ...band, rows: hits.map((hit) => hit.row) }, best: hits[0]?.score ?? 0 };
    })
    .filter((scored) => scored.best > 0)
    .sort((one, other) => other.best - one.best)
    .map((scored) => scored.band);
}
