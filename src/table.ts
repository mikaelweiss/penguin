export function table(rows: string[][]): string {
  const widths = rows[0]?.map((_, index) =>
    Math.max(...rows.map((row) => (row[index] ?? "").length)),
  );
  if (widths === undefined) return "";
  return rows
    .map((row) =>
      row
        .map((cell, index) => cell.padEnd(widths[index] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}
