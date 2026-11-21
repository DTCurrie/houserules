import { spawnSync } from 'node:child_process';

/** A bench case that failed to run: unexpected exit, signal, or timeout. */
export class CaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CaseError';
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BUFFER_BYTES = 256 * 1024 * 1024;
const NANOSECONDS_PER_MILLISECOND = 1e6;

function tail(text, lines = 20) {
  return String(text ?? '')
    .trimEnd()
    .split('\n')
    .slice(-lines)
    .join('\n');
}

function runOnce(benchCase) {
  const expect = benchCase.expectExit ?? [0];
  const timeoutMs = benchCase.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startNanoseconds = process.hrtime.bigint();
  const result = spawnSync(benchCase.command, benchCase.args ?? [], {
    cwd: benchCase.cwd,
    env: { ...process.env, ...benchCase.env },
    input: benchCase.stdin,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BUFFER_BYTES,
    timeout: timeoutMs,
  });
  const endNanoseconds = process.hrtime.bigint();
  const stderrTail = tail(result.stderr);
  if (result.error) {
    const timedOut = result.error.code === 'ETIMEDOUT';
    throw new CaseError(
      `case ${benchCase.name}: ${timedOut ? `timed out after ${timeoutMs}ms` : `spawn failed: ${result.error.message}`}\n${stderrTail}`,
    );
  }
  if (result.signal) {
    throw new CaseError(
      `case ${benchCase.name}: killed by signal ${result.signal}\n${stderrTail}`,
    );
  }
  if (!expect.includes(result.status)) {
    throw new CaseError(
      `case ${benchCase.name}: exit status ${result.status}, expected ${expect.join(' or ')}\n${stderrTail}`,
    );
  }
  return (
    Number(endNanoseconds - startNanoseconds) / NANOSECONDS_PER_MILLISECOND
  );
}

/**
 * Time a case as a whole process. `beforeEach` runs untimed before every run, warmup included.
 * @param {object} benchCase see scripts/bench/README.md, "A case"
 * @param {{ warmup: number, runs: number }} options
 * @returns {{ samplesMs: number[] }}
 * @throws {CaseError}
 */
export function measureCase(benchCase, { warmup, runs }) {
  const samplesMs = [];
  for (let i = 0; i < warmup + runs; i++) {
    if (benchCase.beforeEach) benchCase.beforeEach();
    const ms = runOnce(benchCase);
    if (i >= warmup) samplesMs.push(ms);
  }
  return { samplesMs };
}
