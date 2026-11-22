#!/usr/bin/env node
/**
 * Prints the most task-workers one `orchestrate` wave should dispatch at once.
 *
 * Usage: wave-ceiling.mjs [--workers <n>]
 *
 * Prints one JSON line,
 * `{"ceiling":…,"ncpu":…,"load1":…,"source":…,"budget":…,"share":…}`, and exits 0.
 * `budget` is the script budget and `share` is one run's slice of it. `share` divides
 * the budget by `--workers <n>` when given, else by the ceiling. A missing or invalid
 * `--workers` value is ignored. The ceiling is a number the orchestrator reads, not a
 * limit this script enforces. A missing or broken config never fails the run.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadConfigSafe } from '@houserules/payload/config';
import {
  budgetFor,
  readSignals,
  shareFor,
} from '@houserules/payload/resource-budget';

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

interface FiguresInput extends CeilingInput {
  workers?: number | undefined;
}

/**
 * The ceiling figures plus the script budget and one run's share. The share divides
 * by `workers` when it is a positive integer, else by the ceiling.
 */
export function waveFigures({
  ncpu,
  load1,
  maxWorkers,
  workers,
}: FiguresInput): {
  ceiling: number;
  ncpu: number;
  load1: number;
  source: CeilingSource;
  budget: number;
  share: number;
} {
  const { ceiling, source } = ceilingFor({ ncpu, load1, maxWorkers });
  const budget = budgetFor({ ncpu, load1 });
  const hasWorkers =
    workers !== undefined && Number.isInteger(workers) && workers > 0;
  const share = shareFor(budget, hasWorkers ? workers : ceiling);
  return { ceiling, ncpu, load1, source, budget, share };
}

function workersFlag(argv: string[]): number | undefined {
  const index = argv.indexOf('--workers');
  if (index === -1) return undefined;
  return Number(argv[index + 1]);
}

function main(): void {
  const { ncpu, load1 } = readSignals();
  const maxWorkers = loadConfigSafe().orchestrate?.maxWorkers;
  const workers = workersFlag(process.argv.slice(2));
  const figures = waveFigures({ ncpu, load1, maxWorkers, workers });
  process.stdout.write(`${JSON.stringify(figures)}\n`);
  process.exit(0);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
