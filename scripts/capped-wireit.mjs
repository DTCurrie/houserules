#!/usr/bin/env node
/**
 * Runs a root wireit script with a cap on how many scripts wireit runs at once.
 *
 * Usage:
 *   node scripts/capped-wireit.mjs <script> [args...]
 *
 * Runs `pnpm run <script> [args...]` with `WIREIT_PARALLEL` set to a quarter of
 * the machine's cores, never under 2. Wireit's own default is twice the cores,
 * and each package's vitest starts a worker pool of its own, so the default
 * puts many more workers than cores on the machine and tests time out. A
 * `WIREIT_PARALLEL` the caller already set is left alone.
 *
 * A wireit script's command has to be exactly `wireit`, so the cap cannot be
 * written inline in `package.json`. That is why this wrapper exists.
 *
 * Exit codes: pnpm's own exit code, or 1 when no script is named or pnpm does
 * not start.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const CORES_PER_SCRIPT = 4;
const MIN_PARALLEL = 2;

/**
 * The `WIREIT_PARALLEL` value for a machine: a quarter of its cores, never
 * under 2. A value the caller already set wins.
 */
export function wireitParallel(cores, alreadySet) {
  return (
    alreadySet ??
    String(Math.max(MIN_PARALLEL, Math.floor(cores / CORES_PER_SCRIPT)))
  );
}

function main() {
  const [script, ...scriptArguments] = process.argv.slice(2);
  if (!script) {
    console.error('usage: node scripts/capped-wireit.mjs <script> [args...]');
    process.exit(1);
  }

  process.env.WIREIT_PARALLEL = wireitParallel(
    availableParallelism(),
    process.env.WIREIT_PARALLEL,
  );

  const result = spawnSync('pnpm', ['run', script, ...scriptArguments], {
    stdio: 'inherit',
    // pnpm is a .cmd shim on Windows, which spawn cannot start without a shell.
    shell: process.platform === 'win32',
  });
  process.exit(result.status ?? 1);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
