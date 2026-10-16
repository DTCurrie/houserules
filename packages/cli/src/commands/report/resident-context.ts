import { renderTable } from './render-table.js';
import type { Corpus } from './transcript-events.js';

// Matches doctor/resident-surface.ts so the two token figures compare.
const BYTES_PER_TOKEN_ESTIMATE = 4;
// Matches the token table, which also shows the first eight characters of a session id.
const SESSION_ID_PREVIEW_LENGTH = 8;

const NOT_RECORDED_NOTE = 'not recorded (no session-start attachments)';

const formatCount = (value: number) => value.toLocaleString('en-US');

/** One session's always-loaded context, read from the attachments Claude Code writes at session start. */
interface ResidentContextRow {
  session: string;
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
}

export interface ResidentContextReport {
  rows: ResidentContextRow[];
  recorded: number;
  totalSessions: number;
  medianResidentBytes: number;
  medianEstimatedTokens: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return Math.round(((sorted[middle - 1] ?? 0) + upper) / 2);
}

/** Medians cover recorded sessions only, since an unrecorded one has nothing to measure. */
export function computeResidentContext(corpus: Corpus): ResidentContextReport {
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
  };
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
      return [id, NOT_RECORDED_NOTE, '', '', '', '', '', '', ''];
    return [
      id,
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
    `medians: total ${formatCount(report.medianResidentBytes)} bytes, ~tokens ${formatCount(report.medianEstimatedTokens)}`,
    '',
    '  (bytes of what Claude Code attaches at session start: the system prompt, CLAUDE.md and auto memory,',
    '   the skill and agent listings, and the output style. Nested CLAUDE.md files load on demand and are counted separately.)',
  );
  return lines;
}
