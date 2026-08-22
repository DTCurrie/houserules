import type { Corpus, FileUsage } from './transcript-events.js';

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
function weightedInput(a: {
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
  for (const file of report.files) {
    const id = file.file.replace(/\.jsonl$/, '').slice(0, 8);
    lines.push(
      `  ${id}  turns ${file.turns}  in ${n(file.input)}  out ${n(file.output)}  ` +
        `cache_read ${n(file.cacheRead)}  cache_write ${n(file.cacheWrite)}  ` +
        `tools ${file.toolResults}  weighted-in ${n(weightedInput(file))}` +
        (file.skippedLines
          ? `  (${file.skippedLines} line(s) could not be parsed and were skipped)`
          : ''),
    );
  }

  const { totals } = report;
  const cacheableIn = totals.input + totals.cacheRead + totals.cacheWrite;
  lines.push('');
  lines.push('-- totals --');
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
