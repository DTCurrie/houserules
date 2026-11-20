import { detect } from '../../detect.js';
import type { Corpus } from './transcript-events.js';
import { renderTable } from './render-table.js';

// Two adjacent Bash commands at or above this bigram-dice similarity count as a retry.
const RETRY_SIMILARITY = 0.9;

const READ_ONLY_GIT_CHECK =
  /^(?:cd\s+\S+\s*&&\s*)?git\s+(?:status\b|diff\s+--name-only\b)/;

// The size the `tool-output-trim` hook caps a Bash or Read result at, copied from MAX_BYTES in
// payload/scripts/tool-output-trim.mts because `src` cannot import a payload script.
const TRIM_CAP_BYTES = 16384;

const BULK_TOP_N = 10;
const RETRY_TOP_N = 5;

interface RetryRun {
  session: string;
  length: number;
  command: string;
}

interface ToolBulk {
  tool: string;
  results: number;
  bytes: number;
}

/** Result sizes for one tool, measured the way {@link ToolBulk} measures bytes. */
interface ResultSizeTally {
  results: number;
  bytes: number;
  /** Results above {@link ToolResultSizes.capBytes}. */
  overCap: number;
  /**
   * Bytes past the cap, summed as `bytes - capBytes` over each over-cap result. Absent in an
   * export from before the field existed.
   */
  excessBytes?: number;
}

/** `Read` and `Bash` result sizes against the `tool-output-trim` cap. */
interface ToolResultSizes {
  capBytes: number;
  read: ResultSizeTally;
  bash: ResultSizeTally;
  /** Whether the install records the `tool-output-trim` module. Absent when it could not be read. */
  isTrimInstalled?: boolean;
}

export interface FrictionReport {
  compactedSessions: string[];
  bulkByTool: ToolBulk[];
  retryRuns: RetryRun[];
  denials: { tool: string; command: string }[];
  interrupts: number;
  /** Absent in a document exported before result sizes were read, and rendered as absent, not zero. */
  toolResultSizes?: ToolResultSizes;
}

function bigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

// Dice coefficient over character bigrams: cheap, order-tolerant, and good enough to
// call two command lines "the same command again" without a real edit distance.
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const aCounts = bigramCounts(a);
  const bCounts = bigramCounts(b);
  let shared = 0;
  let total = 0;
  for (const [gram, count] of aCounts) {
    total += count;
    const bCount = bCounts.get(gram);
    if (bCount !== undefined) shared += Math.min(count, bCount);
  }
  for (const count of bCounts.values()) total += count;
  return total ? (2 * shared) / total : 1;
}

/** True for a read-only `git status` or `git diff --name-only` command, with an optional `cd <path> &&` prefix and any pipe after it. */
export function isReadOnlyGitCheck(command: string): boolean {
  return READ_ONLY_GIT_CHECK.test(command.trim());
}

/**
 * Signals for where the session felt friction rather than flowed: compacts, bulk, retries, denials.
 * Read-only git status shapes never count as retries, because a skill prescribes them before every review, so repeating them is the procedure and not friction.
 */
export function computeFriction(corpus: Corpus): FrictionReport {
  const sizes: ToolResultSizes = {
    capBytes: TRIM_CAP_BYTES,
    read: { results: 0, bytes: 0, overCap: 0, excessBytes: 0 },
    bash: { results: 0, bytes: 0, overCap: 0, excessBytes: 0 },
  };
  const compactedSessions: string[] = [];
  const bulkByTool = new Map<string, ToolBulk>();
  const retryRuns: RetryRun[] = [];
  const denials: { tool: string; command: string }[] = [];
  let interrupts = 0;

  for (const [sessionId, session] of corpus.sessions) {
    interrupts += session.interrupts;
    if (
      session.hookFires.some((fire) => fire.hookName === 'SessionStart:compact')
    )
      compactedSessions.push(sessionId.slice(0, 8));

    for (const result of session.toolResults) {
      const index =
        result.toolUseId === undefined
          ? undefined
          : session.toolUseIndexById.get(result.toolUseId);
      const use = index === undefined ? undefined : session.toolUses[index];
      const tool = use?.name ?? '(unmatched)';
      const row = bulkByTool.get(tool) ?? { tool, results: 0, bytes: 0 };
      row.results += 1;
      row.bytes += result.bytes;
      bulkByTool.set(tool, row);
      tallyResultSize(sizes, tool, result.bytes);
      if (result.denied) denials.push({ tool, command: use?.command ?? '' });
      else if (result.interrupted) interrupts += 1;
    }

    // Sidechain Bash calls interleave arbitrarily with the main chain and each other in
    // file order, so adjacency is only meaningful on the main chain.
    const bashCommands = session.toolUses
      .filter((use) => use.name === 'Bash' && !use.isSidechain)
      .map((use) => use.command.trim().replace(/\s+/g, ' '));
    let runLength = 1;
    for (let i = 1; i <= bashCommands.length; i += 1) {
      const previous = bashCommands[i - 1] ?? '';
      const current = bashCommands[i];
      const isNear =
        current !== undefined &&
        !isReadOnlyGitCheck(previous) &&
        similarity(previous, current) >= RETRY_SIMILARITY;
      if (isNear) {
        runLength += 1;
        continue;
      }
      if (runLength >= 2)
        retryRuns.push({
          session: sessionId.slice(0, 8),
          length: runLength,
          command: previous.slice(0, 80),
        });
      runLength = 1;
    }
  }

  return {
    compactedSessions,
    bulkByTool: [...bulkByTool.values()],
    retryRuns,
    denials,
    interrupts,
    toolResultSizes: sizes,
  };
}

/** Counts one result against its tool's tally. Tools other than `Read` and `Bash` count nowhere. */
function tallyResultSize(
  sizes: ToolResultSizes,
  tool: string,
  bytes: number,
): void {
  const tally =
    tool === 'Read' ? sizes.read : tool === 'Bash' ? sizes.bash : undefined;
  if (!tally) return;
  tally.results += 1;
  tally.bytes += bytes;
  if (bytes > sizes.capBytes) {
    tally.overCap += 1;
    tally.excessBytes = (tally.excessBytes ?? 0) + bytes - sizes.capBytes;
  }
}

/**
 * Whether the install at `top` records the `tool-output-trim` module.
 * Returns `undefined` when nothing is installed or the manifest cannot be read.
 */
export function readTrimInstalled(top: string): boolean | undefined {
  try {
    const modules = detect(top).claude.manifest?.modules;
    return modules ? modules.includes('tool-output-trim') : undefined;
  } catch {
    return undefined;
  }
}

function describeTally(label: string, tally: ResultSizeTally): string {
  const average = tally.results ? Math.round(tally.bytes / tally.results) : 0;
  return `${label} ${tally.results} results, avg ${average.toLocaleString('en-US')} bytes, ${tally.overCap} over cap`;
}

/** The result-size line, plus the trim hint when the module is absent and a result ran over. */
function renderResultSizes(sizes: ToolResultSizes): string[] {
  const lines = [
    `  result size vs ${sizes.capBytes.toLocaleString('en-US')}-byte trim cap: ` +
      `${describeTally('Read', sizes.read)}; ${describeTally('Bash', sizes.bash)}`,
  ];
  if (
    sizes.isTrimInstalled === false &&
    sizes.read.overCap + sizes.bash.overCap > 0
  )
    lines.push(
      '    tool-output-trim is not installed. Enable it with `npx houserules modules`.',
    );
  return lines;
}

export function renderFriction(report: FrictionReport): string[] {
  const lines: string[] = [];
  lines.push('-- friction --');
  lines.push('');
  lines.push(
    `  compaction: ${report.compactedSessions.length} session(s) resumed from auto-compact` +
      (report.compactedSessions.length
        ? ` (${report.compactedSessions.join(', ')})`
        : ''),
  );
  lines.push('');
  lines.push('  tool_result bulk (top by bytes):');
  lines.push(
    ...renderTable(
      ['tool', 'results', 'bytes'],
      [...report.bulkByTool]
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, BULK_TOP_N)
        .map((row) => [
          row.tool,
          row.results,
          row.bytes.toLocaleString('en-US'),
        ]),
    ),
  );
  if (report.toolResultSizes)
    lines.push('', ...renderResultSizes(report.toolResultSizes));
  const retriedCalls = report.retryRuns.reduce(
    (sum, run) => sum + run.length - 1,
    0,
  );
  lines.push('');
  lines.push(
    `  bash retries (main chain, adjacent commands >= ${RETRY_SIMILARITY} similar): ` +
      `${report.retryRuns.length} runs, ${retriedCalls} repeated calls`,
  );
  for (const run of [...report.retryRuns]
    .sort((a, b) => b.length - a.length)
    .slice(0, RETRY_TOP_N))
    lines.push(`    ${run.session}  x${run.length}  ${run.command}`);
  lines.push('');
  lines.push(
    `  denials: ${report.denials.length} tool use(s) rejected by the user, ` +
      `${report.interrupts} interrupted mid-call`,
  );
  for (const denial of report.denials.slice(0, RETRY_TOP_N))
    lines.push(
      `    ${denial.tool}${denial.command ? `  ${denial.command.slice(0, 80)}` : ''}`,
    );
  return lines;
}
