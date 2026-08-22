/** Aligns a small table into monospace lines, each indented two spaces. */
export function renderTable(
  headers: string[],
  rows: (string | number)[][],
): string[] {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => String(row[i] ?? '').length)),
  );
  const line = (cells: readonly (string | number)[]) =>
    `  ${cells.map((cell, i) => String(cell).padEnd(widths[i] ?? 0)).join('  ')}`;
  return [
    line(headers),
    line(widths.map((width) => '-'.repeat(width))),
    ...rows.map(line),
  ];
}
