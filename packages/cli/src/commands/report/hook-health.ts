import type { Corpus, HookFire } from './transcript-events.js';
import { crashSignature, isCrash } from './hook-crash.js';
import { renderTable } from './render-table.js';

interface HookHealthRow {
  hook: string;
  fires: number;
  nonZero: number;
  crashes: number;
  blocks: number;
  p50: number;
  p95: number;
  max: number;
}

export interface HookHealthReport {
  rows: HookHealthRow[];
  crashSignatures: { signature: string; count: number }[];
  bashCalls: number;
}

interface HookAccumulator {
  fires: number;
  nonZero: number;
  crashes: number;
  blocks: number;
  durations: number[];
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[index] ?? 0;
}

function accumulate(
  fire: HookFire,
  byHook: Map<string, HookAccumulator>,
): void {
  let row = byHook.get(fire.hookName);
  if (!row) {
    row = { fires: 0, nonZero: 0, crashes: 0, blocks: 0, durations: [] };
    byHook.set(fire.hookName, row);
  }
  row.fires += 1;
  if (typeof fire.durationMs === 'number') row.durations.push(fire.durationMs);
  if (!fire.exitCode) return;
  row.nonZero += 1;
  if (isCrash(fire)) row.crashes += 1;
  else row.blocks += 1;
}

export function computeHookHealth(corpus: Corpus): HookHealthReport {
  const byHook = new Map<string, HookAccumulator>();
  const crashSignatureCounts = new Map<string, number>();
  let bashCalls = 0;
  for (const session of corpus.sessions.values()) {
    for (const fire of session.hookFires) {
      accumulate(fire, byHook);
      if (fire.exitCode && isCrash(fire)) {
        const signature = crashSignature(fire);
        crashSignatureCounts.set(
          signature,
          (crashSignatureCounts.get(signature) ?? 0) + 1,
        );
      }
    }
    bashCalls += session.toolUses.filter((use) => use.name === 'Bash').length;
  }

  const rows: HookHealthRow[] = [...byHook.entries()]
    .map(([hook, row]) => {
      const durations = [...row.durations].sort((a, b) => a - b);
      return {
        hook,
        fires: row.fires,
        nonZero: row.nonZero,
        crashes: row.crashes,
        blocks: row.blocks,
        p50: percentile(durations, 50),
        p95: percentile(durations, 95),
        max: durations.at(-1) ?? 0,
      };
    })
    .sort((a, b) => b.fires - a.fires);

  const crashSignatures = [...crashSignatureCounts.entries()]
    .map(([signature, count]) => ({ signature, count }))
    .sort((a, b) => b.count - a.count);

  return { rows, crashSignatures, bashCalls };
}

export function renderHookHealth(report: HookHealthReport): string[] {
  const tableRows = report.rows.map((row) => [
    row.hook,
    row.fires,
    row.nonZero,
    row.crashes,
    row.blocks,
    row.p50,
    row.p95,
    row.max,
  ]);
  const lines = [
    '-- hook health --',
    '',
    ...renderTable(
      [
        'hook',
        'fires',
        'non-zero',
        'crashes',
        'blocks',
        'p50ms',
        'p95ms',
        'maxms',
      ],
      tableRows,
    ),
    '',
    '  (fires counts recorded attachments, which exist only when a hook emitted output.',
    `   For scale: this corpus holds ${report.bashCalls} Bash tool calls.)`,
  ];
  if (report.crashSignatures.length) {
    lines.push('', '  crash signatures:');
    for (const { signature, count } of report.crashSignatures)
      lines.push(`    ${String(count).padStart(4)}  ${signature}`);
  }
  return lines;
}
