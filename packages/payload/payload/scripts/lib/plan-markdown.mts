interface SliceTable {
  header: string[];
  rows: string[][];
  /** The 1-based line of each entry in `rows`. */
  rowLines: number[];
}

/** The header row and the separator row that open every markdown table. */
export const TABLE_PREAMBLE_ROWS = 2;

/** Finds the `## Slices` markdown table in a phase sub-plan, if it has one. */
export function parseSliceTable(markdown: string): SliceTable | null {
  const start = markdown.indexOf('## Slices');
  if (start === -1) return null;
  const lines: string[] = [];
  const lineNumbers: number[] = [];
  const firstLine = markdown.slice(0, start).split('\n').length;
  const following = markdown.slice(start).split('\n');
  for (const [offset, line] of following.entries()) {
    if (line.trim().startsWith('|')) {
      lines.push(line);
      lineNumbers.push(firstLine + offset);
    } else if (lines.length > 0) break;
  }
  if (lines.length < 2 || lines[0] === undefined) return null;
  const splitRow = (line: string): string[] => {
    const cells = line.split('|').map((cell) => cell.trim());
    while (cells.length > 0 && cells[0] === '') cells.shift();
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    return cells;
  };
  const header = splitRow(lines[0]);
  const rows: string[][] = [];
  const rowLines: number[] = [];
  lines.slice(TABLE_PREAMBLE_ROWS).forEach((line, index) => {
    const cells = splitRow(line);
    if (cells.length < 2) return;
    rows.push(cells);
    rowLines.push(lineNumbers[index + TABLE_PREAMBLE_ROWS] ?? firstLine);
  });
  return { header, rows, rowLines };
}

/**
 * The ROADMAP phase line, shared by `checkRoadmapSync` and `parseRoadmapPhases` so the two
 * read one grammar. Groups: phase number, status cell, sub-plan file, and the optional
 * trailing `After` text. The group takes whatever follows `After:` so a malformed value is
 * seen, not silently read as the chain. `parseRoadmapPhases` decides whether it is `none` or a
 * comma-separated list of phase numbers.
 */
export const ROADMAP_PHASE_LINE =
  /\*\*Phase (\d+)[^*]*\*\*\s*·\s*Status:\s*([A-Z][A-Za-z ]*(?:\([^)]*\))?)\s*·\s*\[sub-plan\]\(([^)]+)\)(?:\s*·\s*After:([^·\n]*))?/;

/** A phase's `After` marker: the chain default, no dependency, or an explicit list of phase numbers. */
type PhaseAfter = 'chain' | 'none' | number[];

export interface RoadmapPhase {
  number: number;
  status: string;
  subplan: string;
  after: PhaseAfter;
  /** Set only when the `After` segment is neither `none` nor a list of integers. `after` is then `chain`. */
  malformedAfter?: string;
}

/** Sorts an `After` cell into `none`, a list of phase numbers, or a malformed segment. */
function classifyAfterCell(
  afterCell: string | undefined,
): Pick<RoadmapPhase, 'after' | 'malformedAfter'> {
  if (afterCell === undefined) return { after: 'chain' };
  const cell = afterCell.trim();
  if (cell === 'none') return { after: 'none' };
  if (/^\d+(?:\s*,\s*\d+)*$/.test(cell)) {
    return { after: cell.split(',').map((part) => Number(part.trim())) };
  }
  return { after: 'chain', malformedAfter: cell };
}

/**
 * Reads every phase line of a ROADMAP. `status` is the raw cell with its parenthetical, and
 * `after` is `chain` when the line carries no `After` segment, and `malformedAfter` holds the
 * text of an `After` segment that is neither `none` nor a comma-separated list of integers.
 */
export function parseRoadmapPhases(markdown: string): RoadmapPhase[] {
  const lineRe = new RegExp(ROADMAP_PHASE_LINE.source, 'g');
  const phases: RoadmapPhase[] = [];
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(markdown))) {
    phases.push({
      number: Number(match[1]),
      status: (match[2] ?? '').trim(),
      subplan: (match[3] ?? '').trim(),
      ...classifyAfterCell(match[4]),
    });
  }
  return phases;
}

/** Reads the value of a file's first `**Status:**` header, up to the first `·`, or `null` when it has none. */
export function parseStatusHeader(markdown: string): string | null {
  const match = markdown.match(/\*\*Status:\*\*\s*([^\n·]+)/);
  return match?.[1]?.trim() ?? null;
}

/** The statuses a phase may carry, in a ROADMAP line and a sub-plan header. */
export const PHASE_STATUSES = [
  'TODO',
  'IN PROGRESS',
  'DONE',
  'DROPPED',
  'BLOCKED',
] as const;

/** The statuses a row of a `## Slices` table may carry. */
export const SLICE_STATUSES = [
  'TODO',
  'DISPATCHED',
  'IN REVIEW',
  'REVISING',
  'DONE',
  'BLOCKED',
] as const;
