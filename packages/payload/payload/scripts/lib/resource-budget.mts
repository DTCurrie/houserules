import { availableParallelism, loadavg } from 'node:os';

/** Worker processes per core, fitted on 18 cores. */
export const WORKERS_PER_CORE = 4;
/**
 * Worker processes per core across one agent wave. Nine concurrent cli suites on
 * 18 cores passed at 36 workers in total and timed out tests at 72.
 */
export const WAVE_WORKERS_PER_CORE = 2;

const MIN_BUDGET = 2;
/** A one-minute load at or above the core count halves the usable cores. */
const LOAD_HALVING_DIVISOR = 2;

export interface BudgetSignals {
  ncpu: number;
  load1: number;
  availableMemory: number;
}

export interface BudgetInput {
  ncpu: number;
  load1: number;
  memory?: { available: number; perWorker: number };
  /** Defaults to `WORKERS_PER_CORE`. A wave passes `WAVE_WORKERS_PER_CORE`. */
  workersPerCore?: number;
}

/**
 * Reads the three signals once. Call it at the top of a run tree and pass the
 * results down, since a child that rereads the load sees its own siblings in it.
 * The one-minute load is 0 on Windows, so it never halves the cores there.
 */
export function readSignals(): BudgetSignals {
  return {
    ncpu: availableParallelism(),
    load1: loadavg()[0] ?? 0,
    availableMemory: process.availableMemory(),
  };
}

/**
 * The script budget `B`: how many worker processes a run tree may keep alive.
 * Cores halve when the one-minute load reaches the core count, the same rule as
 * the agent wave ceiling. The memory term joins only when `memory` is given with
 * a positive `perWorker`.
 */
export function budgetFor(input: BudgetInput): number {
  const { ncpu, load1, memory, workersPerCore = WORKERS_PER_CORE } = input;
  const usableCores =
    load1 >= ncpu ? Math.floor(ncpu / LOAD_HALVING_DIVISOR) : ncpu;
  let budget = workersPerCore * usableCores;
  if (memory !== undefined && memory.perWorker > 0) {
    budget = Math.min(budget, Math.floor(memory.available / memory.perWorker));
  }
  return Math.max(MIN_BUDGET, budget);
}

/**
 * The share `S` of one run among `concurrentRuns`. A non-positive or
 * non-integer count is treated as 1, so a run alone gets the whole budget.
 */
export function shareFor(budget: number, concurrentRuns: number): number {
  const runs =
    Number.isInteger(concurrentRuns) && concurrentRuns > 0 ? concurrentRuns : 1;
  return Math.max(1, Math.floor(budget / runs));
}

/** The default pool `D` of `vitest run`: one under the core count, at least 1. */
export function vitestDefaultPool(ncpu: number): number {
  return Math.max(ncpu - 1, 1);
}

/**
 * Splits a share into an inner pool and an outer fan-out. The inner pool fills
 * first, up to the tool's default, so the outer fan-out absorbs any cut.
 * `inner * outer` stays at or under `share` whenever `share >= 1`.
 */
export function divideShare(
  share: number,
  innerDefault: number,
): { inner: number; outer: number } {
  const inner = Math.max(1, Math.min(innerDefault, share));
  const outer = Math.max(1, Math.floor(share / inner));
  return { inner, outer };
}
