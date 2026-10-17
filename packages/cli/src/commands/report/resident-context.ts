import { isAbsolute, relative } from 'node:path';

import { renderTable } from './render-table.js';
import type { Corpus } from './transcript-events.js';

// Matches doctor/resident-surface.ts so the two token figures compare.
const BYTES_PER_TOKEN_ESTIMATE = 4;
// Matches the token table, which also shows the first eight characters of a session id.
const SESSION_ID_PREVIEW_LENGTH = 8;

const NOT_RECORDED_NOTE = 'not recorded (no session-start attachments)';

const formatCount = (value: number) => value.toLocaleString('en-US');

/** One session's always-loaded context, read from the attachments Claude Code writes at session start. */
export interface ResidentContextRow {
  session: string;
  /** How the session was launched. Absent in an export written before it was recorded. */
  entrypoint?: string;
  /** False when the transcript carries none of the session-start attachments. */
  recorded: boolean;
  systemPromptBytes: number;
  /** Sum over the instruction files, which hold CLAUDE.md and auto memory. */
  instructionBytes: number;
  skillListingBytes: number;
  agentListingBytes: number;
  outputStyleBytes: number;
  /** Sum of the five start-of-session byte fields above. */
  residentBytes: number;
  estimatedTokens: number;
  nestedMemoryLoads: number;
  nestedMemoryBytes: number;
  /** Nested loads split by transcript origin. Absent in an export written before the split. */
  nestedMemoryByOrigin?: {
    main: NestedMemoryTally;
    subagent: NestedMemoryTally;
  };
  /** Per loaded file, sorted by bytes descending. Absent in an export written before the split. */
  nestedMemoryFiles?: ({ path: string } & NestedMemoryTally)[];
}

interface NestedMemoryTally {
  loads: number;
  bytes: number;
}

// The nested-loads readout lists this many files and summarizes the rest.
const NESTED_FILE_ROWS = 10;

const UNKNOWN_ENTRYPOINT = 'unknown';

export interface EntrypointMedian {
  entrypoint: string;
  sessions: number;
  medianResidentBytes: number;
  medianEstimatedTokens: number;
}

export interface ResidentContextReport {
  rows: ResidentContextRow[];
  recorded: number;
  totalSessions: number;
  medianResidentBytes: number;
  medianEstimatedTokens: number;
  /** Absent in an export written before medians were split by entrypoint. */
  medianByEntrypoint?: EntrypointMedian[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return Math.round(((sorted[middle - 1] ?? 0) + upper) / 2);
}

/** Groups recorded rows by entrypoint, sorted by name, with rows lacking one under `unknown`. */
export function entrypointMedians(
  rows: ResidentContextRow[],
): EntrypointMedian[] {
  const groups = new Map<string, ResidentContextRow[]>();
  for (const row of rows) {
    if (!row.recorded) continue;
    const key = row.entrypoint ?? UNKNOWN_ENTRYPOINT;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([entrypoint, members]) => ({
      entrypoint,
      sessions: members.length,
      medianResidentBytes: median(members.map((row) => row.residentBytes)),
      medianEstimatedTokens: median(members.map((row) => row.estimatedTokens)),
    }));
}

function repoRelative(path: string, top: string | undefined): string {
  if (top === undefined || !isAbsolute(path)) return path;
  const relativePath = relative(top, path);
  return relativePath.startsWith('..') || isAbsolute(relativePath)
    ? path
    : relativePath;
}

/**
 * Medians cover recorded sessions only, since an unrecorded one has nothing to measure.
 * Pass `top` to render nested-memory file paths relative to the repo root.
 */
export function computeResidentContext(
  corpus: Corpus,
  top?: string,
): ResidentContextReport {
  const rows = corpus.files.map((file): ResidentContextRow => {
    const session = file.file.replace(/\.jsonl$/, '');
    const capture = corpus.residentCaptures.get(session);
    const recorded =
      capture !== undefined &&
      (capture.systemPromptBytes !== undefined ||
        capture.instructionFiles.length > 0 ||
        capture.skillListingBytes !== undefined ||
        capture.agentListingBytes !== undefined ||
        capture.outputStyleBytes !== undefined);
    if (!recorded) {
      return {
        session,
        entrypoint: capture?.entrypoint,
        recorded: false,
        systemPromptBytes: 0,
        instructionBytes: 0,
        skillListingBytes: 0,
        agentListingBytes: 0,
        outputStyleBytes: 0,
        residentBytes: 0,
        estimatedTokens: 0,
        nestedMemoryLoads: 0,
        nestedMemoryBytes: 0,
      };
    }
    const systemPromptBytes = capture.systemPromptBytes ?? 0;
    const instructionBytes = capture.instructionFiles.reduce(
      (sum, entry) => sum + entry.bytes,
      0,
    );
    const skillListingBytes = capture.skillListingBytes ?? 0;
    const agentListingBytes = capture.agentListingBytes ?? 0;
    const outputStyleBytes = capture.outputStyleBytes ?? 0;
    const residentBytes =
      systemPromptBytes +
      instructionBytes +
      skillListingBytes +
      agentListingBytes +
      outputStyleBytes;
    return {
      session,
      entrypoint: capture.entrypoint,
      recorded: true,
      systemPromptBytes,
      instructionBytes,
      skillListingBytes,
      agentListingBytes,
      outputStyleBytes,
      residentBytes,
      estimatedTokens: Math.ceil(residentBytes / BYTES_PER_TOKEN_ESTIMATE),
      nestedMemoryLoads: capture.nestedMemoryLoads,
      nestedMemoryBytes: capture.nestedMemoryBytes,
      nestedMemoryByOrigin: capture.nestedMemoryByOrigin,
      nestedMemoryFiles: [...capture.nestedMemoryFiles.entries()]
        .map(([path, tally]) => ({ path: repoRelative(path, top), ...tally }))
        .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)),
    };
  });
  const recordedRows = rows.filter((row) => row.recorded);
  return {
    rows,
    recorded: recordedRows.length,
    totalSessions: rows.length,
    medianResidentBytes: median(recordedRows.map((row) => row.residentBytes)),
    medianEstimatedTokens: median(
      recordedRows.map((row) => row.estimatedTokens),
    ),
    medianByEntrypoint: entrypointMedians(recordedRows),
  };
}

function medianLines(report: ResidentContextReport): string[] {
  const groups = report.medianByEntrypoint ?? entrypointMedians(report.rows);
  return [
    `medians (all sessions): total ${formatCount(report.medianResidentBytes)} bytes, ~tokens ${formatCount(report.medianEstimatedTokens)}`,
    ...groups.map(
      (group) =>
        `medians (${group.entrypoint}, ${formatCount(group.sessions)} session(s)): total ${formatCount(group.medianResidentBytes)} bytes, ~tokens ${formatCount(group.medianEstimatedTokens)}`,
    ),
  ];
}

function nestedLines(row: ResidentContextRow): string[] {
  const origins = row.nestedMemoryByOrigin;
  if (!origins || row.nestedMemoryLoads === 0) return [];
  const files = row.nestedMemoryFiles ?? [];
  const tally = (label: string, value: NestedMemoryTally) =>
    `    ${label}: ${formatCount(value.loads)} loads (${formatCount(value.bytes)} bytes)`;
  const hidden = files.length - NESTED_FILE_ROWS;
  return [
    `  nested loads, ${row.session.slice(0, SESSION_ID_PREVIEW_LENGTH)}: ${formatCount(row.nestedMemoryLoads)} loads (${formatCount(row.nestedMemoryBytes)} bytes)`,
    tally('main chain', origins.main),
    tally('subagents', origins.subagent),
    ...files
      .slice(0, NESTED_FILE_ROWS)
      .map(
        (file) =>
          `    ${file.path}: ${formatCount(file.loads)} loads (${formatCount(file.bytes)} bytes)`,
      ),
    ...(hidden > 0 ? [`    +${hidden} more`] : []),
  ];
}

export function renderResidentContext(report: ResidentContextReport): string[] {
  const lines = [
    '-- resident context --',
    '',
    `recorded ${report.recorded} of ${report.totalSessions} session(s)`,
  ];
  if (report.recorded === 0) {
    lines.push('no session recorded its session-start attachments');
    return lines;
  }
  const tableRows = report.rows.map((row) => {
    const id = row.session.slice(0, SESSION_ID_PREVIEW_LENGTH);
    if (!row.recorded)
      return [id, '', NOT_RECORDED_NOTE, '', '', '', '', '', '', ''];
    return [
      id,
      row.entrypoint ?? UNKNOWN_ENTRYPOINT,
      formatCount(row.systemPromptBytes),
      formatCount(row.instructionBytes),
      formatCount(row.skillListingBytes),
      formatCount(row.agentListingBytes),
      formatCount(row.outputStyleBytes),
      formatCount(row.residentBytes),
      formatCount(row.estimatedTokens),
      `${formatCount(row.nestedMemoryLoads)} (${formatCount(row.nestedMemoryBytes)})`,
    ];
  });
  lines.push(
    '',
    ...renderTable(
      [
        'session',
        'entrypoint',
        'system',
        'instructions',
        'skills',
        'agents',
        'style',
        'total',
        '~tokens',
        'nested loads',
      ],
      tableRows,
    ),
    '',
    ...medianLines(report),
    '',
    ...report.rows.flatMap((row) => nestedLines(row)),
    ...(report.rows.some((row) => nestedLines(row).length > 0) ? [''] : []),
    '  (bytes of what Claude Code attaches at session start: the system prompt, CLAUDE.md and auto memory,',
    '   the skill and agent listings, and the output style. Nested CLAUDE.md files load on demand and are counted separately.)',
  );
  return lines;
}
