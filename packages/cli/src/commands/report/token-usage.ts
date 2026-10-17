import type { Corpus, FileUsage, UsageSlice } from './transcript-events.js';

interface TokenTotals {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  toolResults: number;
  models: string[];
  sidechainTurns: number;
  skippedLines: number;
}

export interface TokenUsageReport {
  files: FileUsage[];
  totals: TokenTotals;
  unreadableFileCount: number;
}

// Anthropic cache multipliers relative to base input price: a cache READ bills at
// ~0.1×, a cache WRITE at ~1.25×. Output is a different axis, reported separately.
const CACHE_READ_WEIGHT = 0.1;
const CACHE_WRITE_WEIGHT = 1.25;

const n = (x: number) => x.toLocaleString('en-US');
const pct = (num: number, den: number) =>
  den ? `${Math.round((num / den) * 100)}%` : '0%';

// Cost-weighted input-equivalent: fresh input at 1×, cache writes at 1.25×, cache
// reads at 0.1×. So a session that offloaded work into the cache reads as cheaper.
export function weightedInput(a: {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}): number {
  return Math.round(
    a.input +
      a.cacheWrite * CACHE_WRITE_WEIGHT +
      a.cacheRead * CACHE_READ_WEIGHT,
  );
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

function formatWallClock(durationMs: number): string {
  const minutes = Math.floor(durationMs / MS_PER_MINUTE);
  if (minutes < 1) return '<1m';
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m`;
  return `${Math.floor(minutes / MINUTES_PER_HOUR)}h ${minutes % MINUTES_PER_HOUR}m`;
}

const sliceCounts = (slice: UsageSlice) =>
  `weighted-in ${n(weightedInput(slice))} out ${n(slice.output)}`;

export function computeTokenUsage(corpus: Corpus): TokenUsageReport {
  const totals: TokenTotals = {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    toolResults: 0,
    models: [],
    sidechainTurns: 0,
    skippedLines: 0,
  };
  const seenModels = new Set<string>();
  for (const file of corpus.files) {
    totals.turns += file.turns;
    totals.input += file.input;
    totals.output += file.output;
    totals.cacheRead += file.cacheRead;
    totals.cacheWrite += file.cacheWrite;
    totals.toolResults += file.toolResults;
    totals.sidechainTurns += file.sidechainTurns;
    totals.skippedLines += file.skippedLines;
    for (const model of file.models) {
      if (!seenModels.has(model)) {
        seenModels.add(model);
        totals.models.push(model);
      }
    }
  }
  return {
    files: corpus.files,
    totals,
    unreadableFileCount: corpus.unreadableFiles.length,
  };
}

export function renderTokenUsage(report: TokenUsageReport): string[] {
  const lines: string[] = [];
  lines.push(`${report.files.length} session(s):`);
  lines.push('');
  for (const file of report.files) lines.push(...renderFileUsage(file));

  lines.push('');
  lines.push('-- totals --');
  return lines.concat(renderTotals(report));
}

/** One session's row, its wall-clock tail, its origin line, and its by-model line. */
function renderFileUsage(file: FileUsage): string[] {
  const lines: string[] = [];
  const id = file.file.replace(/\.jsonl$/, '').slice(0, 8);
  lines.push(
    `  ${id}  turns ${file.turns}  in ${n(file.input)}  out ${n(file.output)}  ` +
      `cache_read ${n(file.cacheRead)}  cache_write ${n(file.cacheWrite)}  ` +
      `tools ${file.toolResults}  weighted-in ${n(weightedInput(file))}` +
      (file.skippedLines
        ? `  (${file.skippedLines} line(s) could not be parsed and were skipped)`
        : '') +
      (file.firstTs !== undefined && file.lastTs !== undefined
        ? `  wall ${formatWallClock(file.lastTs - file.firstTs)}`
        : ''),
  );
  const indent = ' '.repeat(id.length + 4);
  lines.push(
    `${indent}main ${sliceCounts(file.byOrigin.main)} | subagents ${sliceCounts(file.byOrigin.subagent)}`,
  );
  if (file.byModel.size) {
    lines.push(
      indent +
        [...file.byModel]
          .map(([model, slice]) => `${model}: ${sliceCounts(slice)}`)
          .join(' | '),
    );
  }
  return lines;
}

function renderTotals(report: TokenUsageReport): string[] {
  const lines: string[] = [];
  const { totals } = report;
  const cacheableIn = totals.input + totals.cacheRead + totals.cacheWrite;
  lines.push(
    `  turns ${n(totals.turns)} | fresh input ${n(totals.input)} | output ${n(totals.output)}`,
  );
  lines.push(
    `  cache_read ${n(totals.cacheRead)} | cache_write ${n(totals.cacheWrite)} | tool_results ${n(totals.toolResults)}`,
  );
  lines.push(
    `  cache-read share of input: ${pct(totals.cacheRead, cacheableIn)} (cheap tier — the higher the better)`,
  );
  lines.push(
    `  cost-weighted input-equivalent: ${n(weightedInput(totals))} (cache_read ×${CACHE_READ_WEIGHT}, cache_write ×${CACHE_WRITE_WEIGHT})`,
  );
  lines.push(
    `  models: ${totals.models.join(', ') || '(none)'} | sidechain turns: ${pct(totals.sidechainTurns, totals.turns)}`,
  );
  lines.push('');
  lines.push(
    '(cache_read is cost-weighted, never summed flat with fresh input; native /usage covers the live view.)',
  );
  if (report.unreadableFileCount || totals.skippedLines) {
    lines.push(
      `(${report.unreadableFileCount} session file(s) and ${totals.skippedLines} line(s) across the rest could not be parsed and were excluded from the totals above.)`,
    );
  }
  return lines;
}
