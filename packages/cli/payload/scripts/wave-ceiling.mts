#!/usr/bin/env node
/**
 * Prints the most task-workers one `orchestrate` wave should dispatch at once.
 *
 * Usage: wave-ceiling.mjs
 *
 * Takes no arguments. Prints one JSON line, `{"ceiling":…,"ncpu":…,"load1":…,"source":…}`,
 * and exits 0. The ceiling is a number the orchestrator reads, not a limit this script
 * enforces. A missing or broken config never fails the run.
 */
import { realpathSync } from 'node:fs';
import { availableParallelism, loadavg } from 'node:os';
import { pathToFileURL } from 'node:url';

import { loadConfigSafe } from '@houserules/payload/config';

type CeilingSource = 'maxWorkers' | 'cpu' | 'maxWorkers+load' | 'cpu+load';

interface CeilingInput {
  ncpu: number;
  load1: number;
  maxWorkers?: unknown;
}

const MIN_CPU_CEILING = 2;
const MIN_LOADED_CEILING = 1;
/** The CPU rule takes half the cores, and the load rule halves whatever base it gets. */
const HALVING_DIVISOR = 2;

/**
 * Computes the wave ceiling. An explicit `maxWorkers` is the base and is never clamped to
 * the core count. Without one the base is half the cores, at least 2. A one-minute load
 * average at or above the core count halves the base, down to a floor of 1.
 */
export function ceilingFor({ ncpu, load1, maxWorkers }: CeilingInput): {
  ceiling: number;
  source: CeilingSource;
} {
  const hasOverride =
    typeof maxWorkers === 'number' &&
    Number.isInteger(maxWorkers) &&
    maxWorkers > 0;
  const base = hasOverride
    ? maxWorkers
    : Math.max(MIN_CPU_CEILING, Math.floor(ncpu / HALVING_DIVISOR));
  const baseSource = hasOverride ? 'maxWorkers' : 'cpu';
  if (load1 >= ncpu) {
    return {
      ceiling: Math.max(MIN_LOADED_CEILING, Math.floor(base / HALVING_DIVISOR)),
      source: `${baseSource}+load`,
    };
  }
  return { ceiling: base, source: baseSource };
}

function main(): void {
  const ncpu = availableParallelism();
  const load1 = loadavg()[0] ?? 0;
  const maxWorkers = loadConfigSafe().orchestrate?.maxWorkers;
  const { ceiling, source } = ceilingFor({ ncpu, load1, maxWorkers });
  process.stdout.write(`${JSON.stringify({ ceiling, ncpu, load1, source })}\n`);
  process.exit(0);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
