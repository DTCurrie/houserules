import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HOOK_RUNS_LOG_PATH,
  HOOK_RUNS_ROTATED_PATH,
  hookRunPath,
  type HookRunRecord,
} from '../../hook-runs-log.js';
import type { Corpus, HookFire, HookOutcome } from './transcript-events.js';
import {
  crashSignature,
  dispatchedFailures,
  isCrash,
  uncoveredOutcomes,
} from './hook-crash.js';
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

/** One Stop hook's timing over every `stop_hook_summary`, quiet runs included. */
interface StopHookRow {
  /** The script the hook runs, mapped back from the record's `statusMessage` where one was set. */
  hook: string;
  runs: number;
  p50: number;
  p95: number;
  max: number;
  /**
   * Runs at or past {@link STOP_HOOK_TIMEOUT_MS}. The record carries no timeout marker, so
   * this is the kit's 120 s Stop-hook timeout read off `durationMs`. A run with no
   * `durationMs` counts as 0 ms.
   */
  timeouts: number;
  /**
   * Runs longer than {@link SLOW_STOP_MS}, the tail the p95 can hide. Absent in a document
   * exported before it was counted, and rendered as absent, not zero.
   */
  slowRuns?: number;
  /**
   * Each run counted in {@link timeouts}, with its ISO timestamp and the session's `file` key
   * the token rows carry. Absent in a document exported before it was recorded. A run whose
   * record had no timestamp has no `date`.
   */
  timedOutRuns?: { date?: string; session: string }[];
}

/** One group of dispatcher runs: how many, the median wall time, and the total wall time. */
interface RunLogTiming {
  /** Runs in the group. */
  runs: number;
  /** Median wall time of the group, in milliseconds. */
  medianMilliseconds: number;
  /** Summed wall time of the group, in seconds, rounded to one decimal. */
  totalSeconds: number;
}

/** One path a Stop script took, read from the dispatcher run log. */
interface StopPathRow extends RunLogTiming {
  /** The Stop script's basename. */
  script: string;
  /** `clean` exited 0 and printed nothing. `dirty` is any other run, the one that costs a turn. */
  path: 'clean' | 'dirty';
}

/** What the dispatcher run log recorded inside the corpus window. */
interface RunLogReport {
  /** One row per Stop script and path that ran, sorted by script then clean before dirty. */
  stopPaths: StopPathRow[];
  /** Timing of every `guard-bash.mjs` run. Absent when the log holds none. */
  guard?: RunLogTiming;
}

export interface HookHealthReport {
  rows: HookHealthRow[];
  crashSignatures: { signature: string; count: number }[];
  bashCalls: number;
  /** Absent in a document exported before Stop runs were read, and rendered as absent, not zero. */
  stopHooks?: StopHookRow[];
  /** Absent when the repo has no dispatcher run log, and in a document exported before it was read. */
  runLog?: RunLogReport;
}

const GUARD_SCRIPT = 'guard-bash.mjs';
const STOP_EVENT = 'Stop';
const TOTAL_SECONDS_DECIMALS = 1;
const MEDIAN_PERCENTILE = 50;

function isRunRecord(value: unknown): value is HookRunRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.at === 'string' &&
    typeof record.event === 'string' &&
    typeof record.script === 'string' &&
    typeof record.hasOutput === 'boolean' &&
    typeof record.durationMilliseconds === 'number' &&
    (record.exitCode === null || typeof record.exitCode === 'number')
  );
}

/** Reads one log file's records, skipping unparseable lines. A missing file is no records. */
function readRunFile(path: string): HookRunRecord[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const records: HookRunRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRunRecord(parsed)) records.push(parsed);
    } catch {
      continue;
    }
  }
  return records;
}

function timing(durations: number[]): RunLogTiming {
  const sorted = [...durations].sort((a, b) => a - b);
  const total = sorted.reduce((sum, duration) => sum + duration, 0);
  return {
    runs: sorted.length,
    medianMilliseconds: percentile(sorted, MEDIAN_PERCENTILE),
    totalSeconds: Number(
      (total / MS_PER_SECOND).toFixed(TOTAL_SECONDS_DECIMALS),
    ),
  };
}

function computeRunLog(corpus: Corpus, root: string): RunLogReport | undefined {
  const files = [
    join(root, HOOK_RUNS_ROTATED_PATH),
    join(root, HOOK_RUNS_LOG_PATH),
  ];
  if (!files.some((file) => existsSync(file))) return undefined;
  const { firstTs, lastTs } = corpus;
  const records = files.flatMap(readRunFile).filter((record) => {
    if (firstTs === undefined || lastTs === undefined) return true;
    const at = Date.parse(record.at);
    return at >= firstTs && at <= lastTs;
  });
  const guardDurations = records
    .filter((record) => record.script === GUARD_SCRIPT)
    .map((record) => record.durationMilliseconds);
  return {
    stopPaths: groupStopPaths(
      records.filter((record) => record.event === STOP_EVENT),
    ),
    ...(guardDurations.length ? { guard: timing(guardDurations) } : {}),
  };
}

/** One row per Stop script and path it took, sorted by script then path. */
function groupStopPaths(records: HookRunRecord[]): StopPathRow[] {
  const byScript = new Map<string, Map<StopPathRow['path'], number[]>>();
  for (const record of records) {
    const byPath = byScript.get(record.script) ?? new Map();
    const path = hookRunPath(record);
    byPath.set(path, [
      ...(byPath.get(path) ?? []),
      record.durationMilliseconds,
    ]);
    byScript.set(record.script, byPath);
  }
  return [...byScript.entries()]
    .flatMap(([script, byPath]) =>
      [...byPath.entries()].map(([path, durations]): StopPathRow => ({
        script,
        path,
        ...timing(durations),
      })),
    )
    .sort(
      (a, b) =>
        a.script.localeCompare(b.script) || a.path.localeCompare(b.path),
    );
}

interface HookAccumulator {
  fires: number;
  nonZero: number;
  crashes: number;
  blocks: number;
  durations: number[];
}

const STOP_HOOK_TIMEOUT_MS = 120_000;
const MS_PER_SECOND = 1000;
const SLOW_STOP_MS = 1000;
/** Column label for {@link formatTailShare}, derived so it tracks the threshold. */
export const SLOW_STOP_LABEL = `over ${SLOW_STOP_MS / MS_PER_SECOND}s`;
const PERCENT = 100;
const TAIL_SHARE_DECIMALS = 2;
const ABSENT = '-';
export const STOP_TOTAL_LABEL = '(per Stop total)';

// A summary names a hook by its statusMessage when it set one. lint-fix.ts sets the first
// text, and the second is the older wording field-quality-scan.mjs also maps.
const STATUS_MESSAGE_SCRIPTS = new Map([
  ['Running lint/format auto-fix', 'lint-format-fix.mjs'],
  ['Running lint:fix + format:fix', 'lint-format-fix.mjs'],
]);
const SCRIPT_BASENAME = /([\w-]+\.mjs)/;

function stopHookName(command: string): string {
  const mapped = STATUS_MESSAGE_SCRIPTS.get(command);
  if (mapped) return mapped;
  return SCRIPT_BASENAME.exec(command)?.[1] ?? command;
}

function stopRow(
  hook: string,
  durations: number[],
  timedOutRuns: { date?: string; session: string }[],
): StopHookRow {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    hook,
    runs: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted.at(-1) ?? 0,
    timeouts: sorted.filter((ms) => ms >= STOP_HOOK_TIMEOUT_MS).length,
    slowRuns: sorted.filter((ms) => ms > SLOW_STOP_MS).length,
    ...(timedOutRuns.length ? { timedOutRuns } : {}),
  };
}

/** `<count> (<pct>%)` of runs over {@link SLOW_STOP_MS}, or `-` for a row without the count. */
export function formatTailShare(row: StopHookRow): string {
  if (row.slowRuns === undefined) return ABSENT;
  const pct = row.runs ? (row.slowRuns / row.runs) * PERCENT : 0;
  return `${row.slowRuns} (${pct.toFixed(TAIL_SHARE_DECIMALS)}%)`;
}

function computeStopHooks(corpus: Corpus): StopHookRow[] {
  const byHook = new Map<string, number[]>();
  const timedOut = new Map<string, { date?: string; session: string }[]>();
  const totals: number[] = [];
  for (const session of corpus.sessions.values())
    for (const summary of session.stopHookSummaries) {
      let total = 0;
      for (const run of summary.hooks) {
        const name = stopHookName(run.command);
        const ms = run.durationMs ?? 0;
        const list = byHook.get(name) ?? [];
        list.push(ms);
        byHook.set(name, list);
        total += ms;
        if (ms >= STOP_HOOK_TIMEOUT_MS) {
          const runs = timedOut.get(name) ?? [];
          runs.push({
            ...(summary.ts === undefined
              ? {}
              : { date: new Date(summary.ts).toISOString() }),
            session: summary.file,
          });
          timedOut.set(name, runs);
        }
      }
      totals.push(total);
    }
  if (!totals.length) return [];
  const rows = [...byHook.entries()]
    .map(([hook, durations]) =>
      stopRow(hook, durations, timedOut.get(hook) ?? []),
    )
    .sort((a, b) => b.runs - a.runs || a.hook.localeCompare(b.hook));
  return [...rows, stopRow(STOP_TOTAL_LABEL, totals, [])];
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

// A guard block reaches the transcript only as an error tool_result, which records no exit
// code and no position, so the synthesized fire takes the blocking exit and no position.
const BLOCKING_EXIT_CODE = 2;
const UNKNOWN_TOOL_USE_POSITION = 0;

function fireFromOutcome(outcome: HookOutcome): HookFire {
  return {
    hookName: `PreToolUse:${outcome.tool}`,
    exitCode: BLOCKING_EXIT_CODE,
    stderr: outcome.stderr,
    content: '',
    toolUseID: outcome.toolUseId,
    afterToolUseCount: UNKNOWN_TOOL_USE_POSITION,
  };
}

function countCrashSignature(
  fire: HookFire,
  crashSignatureCounts: Map<string, number>,
): void {
  if (!fire.exitCode || !isCrash(fire)) return;
  const signature = crashSignature(fire);
  crashSignatureCounts.set(
    signature,
    (crashSignatureCounts.get(signature) ?? 0) + 1,
  );
}

/** A dispatched record becomes one fire per failed script it names, other records pass through. */
function splitDispatched(fire: HookFire): HookFire[] {
  const failures = dispatchedFailures(fire.stderr);
  if (!failures.length) return [fire];
  return failures.map((failure) => ({
    ...fire,
    hookName: failure.script,
    exitCode: failure.exitCode,
    stderr: failure.line,
  }));
}

/** `root` is the repo root holding the dispatcher run log under `.claude/state/`. */
export function computeHookHealth(
  corpus: Corpus,
  root: string,
): HookHealthReport {
  const byHook = new Map<string, HookAccumulator>();
  const crashSignatureCounts = new Map<string, number>();
  let bashCalls = 0;
  for (const session of corpus.sessions.values()) {
    const fires = [
      ...session.hookFires.flatMap(splitDispatched),
      ...uncoveredOutcomes(session).map(fireFromOutcome),
    ];
    for (const fire of fires) {
      accumulate(fire, byHook);
      countCrashSignature(fire, crashSignatureCounts);
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

  const runLog = computeRunLog(corpus, root);
  return {
    rows,
    crashSignatures,
    bashCalls,
    stopHooks: computeStopHooks(corpus),
    ...(runLog ? { runLog } : {}),
  };
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
  if (report.stopHooks) lines.push(...renderStopHooks(report.stopHooks));
  if (report.runLog) lines.push(...renderRunLog(report.runLog));
  return lines;
}

function renderRunLog(runLog: RunLogReport): string[] {
  const lines: string[] = [];
  if (runLog.stopPaths.length)
    lines.push(
      '',
      '  Stop hook paths:',
      ...renderTable(
        ['script', 'path', 'runs', 'median ms', 'total s'],
        runLog.stopPaths.map((row) => [
          row.script,
          row.path,
          row.runs,
          row.medianMilliseconds,
          row.totalSeconds,
        ]),
      ),
    );
  if (runLog.guard)
    lines.push(
      '',
      '  Bash guard duration:',
      ...renderTable(
        ['script', 'runs', 'median ms', 'total s'],
        [
          [
            GUARD_SCRIPT,
            runLog.guard.runs,
            runLog.guard.medianMilliseconds,
            runLog.guard.totalSeconds,
          ],
        ],
      ),
    );
  return lines;
}

function renderStopHooks(stopHooks: StopHookRow[]): string[] {
  if (!stopHooks.length)
    return ['', '  Stop hooks: no Stop runs were recorded.'];
  return [
    '',
    '  Stop hooks (every stop_hook_summary, quiet runs included):',
    ...renderTable(
      ['hook', 'runs', 'p50ms', 'p95ms', SLOW_STOP_LABEL, 'maxms', 'timeouts'],
      stopHooks.map((row) => [
        row.hook,
        row.runs,
        row.p50,
        row.p95,
        formatTailShare(row),
        row.max,
        row.timeouts,
      ]),
    ),
    `  (timeouts count runs of ${STOP_HOOK_TIMEOUT_MS / MS_PER_SECOND} s or more.)`,
  ];
}
