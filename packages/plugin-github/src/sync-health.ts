import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CheckResult, Ctx, Finding } from '@houserules/api';

/** Mirrors `PUSH_OUTCOME_PREFIX` in `payload/scripts/lib/push-outcome.mts`. */
const PUSH_OUTCOME_PREFIX = 'projects-sync push outcome ';

/** Mirrors `STATE_DIR` and `LOG_BASENAME` in `payload/scripts/projects-sync-hook.mts`. */
const PUSH_LOG_PATH = '.claude/state/projects-sync.log';

/** Mirrors `PROJECTS_ENABLE_TOKEN` in `packages/payload/payload/scripts/lib/entry-ledger.mts`. */
const PROJECTS_ENABLE_TOKEN = '.projects.json';

/** Mirrors `DEFAULT_LEDGER_DIR` in `packages/payload/payload/scripts/lib/entry-ledger.mts`. */
const DEFAULT_LEDGER_DIR = '.claude/ledgers';

const INSPECT_COMMAND = 'node .claude/scripts/projects-sync.mjs push --dry-run';

interface ParsedOutcome {
  at: string;
  exitCode: number;
  error: string | null;
  pending: { backlog: number; decisions: number } | null;
}

/** Mirrors `ledgerDir` in `entry-ledger.mts`: a configured dir outside the root falls back. */
function resolveLedgerDir(
  root: string,
  configured: string | undefined,
): string {
  const absoluteRoot = resolve(root);
  const fallback = resolve(absoluteRoot, DEFAULT_LEDGER_DIR);
  const dir = resolve(absoluteRoot, configured || DEFAULT_LEDGER_DIR);
  if (dir === absoluteRoot) return fallback;
  return dir.startsWith(`${absoluteRoot}/`) ? dir : fallback;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseOutcome(json: string): ParsedOutcome | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { at, exitCode, error, pending } = record;
  if (typeof at !== 'string' || !isCount(exitCode)) return null;
  if (error !== null && typeof error !== 'string') return null;
  if (pending === null) return { at, exitCode, error, pending: null };
  if (typeof pending !== 'object') return null;
  const counts = pending as Record<string, unknown>;
  const { backlog, decisions } = counts;
  if (!isCount(backlog) || !isCount(decisions)) return null;
  return { at, exitCode, error, pending: { backlog, decisions } };
}

function lastOutcome(log: string): ParsedOutcome | null {
  const lines = log.split('\n');
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? '';
    if (!line.startsWith(PUSH_OUTCOME_PREFIX)) continue;
    const outcome = parseOutcome(line.slice(PUSH_OUTCOME_PREFIX.length));
    if (outcome) return outcome;
  }
  return null;
}

function describePending(pending: ParsedOutcome['pending']): string {
  if (pending === null) return 'pending count unavailable';
  const total = pending.backlog + pending.decisions;
  return `${total} pending (backlog ${pending.backlog}, decisions ${pending.decisions})`;
}

function readLog(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * Reports how the last background ledger push ended, read from the hook's log.
 *
 * Prints nothing when sync is not allowed here: no enable token in the ledger directory, or
 * `projects.autoSync` set to false. A failed last push is one WARN naming its time, error,
 * pending counts, and the dry-run command to inspect it. Reads only, never spawns, never throws.
 */
export function checkSyncHealth(ctx: Ctx): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];

  if (ctx.claude.houseConfig?.projects?.autoSync === false)
    return { findings, readouts };
  const ledgers = resolveLedgerDir(
    ctx.root,
    ctx.claude.houseConfig?.ledgers?.dir,
  );
  if (!existsSync(resolve(ledgers, PROJECTS_ENABLE_TOKEN))) {
    return { findings, readouts };
  }

  const log = readLog(resolve(ctx.root, PUSH_LOG_PATH));
  const outcome = log === null ? null : lastOutcome(log);
  if (outcome === null) {
    readouts.push('projects: no ledger push is recorded yet');
    return { findings, readouts };
  }

  if (outcome.exitCode === 0) {
    readouts.push(
      `projects: last ledger push succeeded at ${outcome.at}, ${describePending(outcome.pending)}`,
    );
    return { findings, readouts };
  }

  findings.push({
    level: 'WARN',
    msg: `projects: last ledger push failed at ${outcome.at} (exit ${outcome.exitCode}): ${outcome.error ?? 'no error was recorded'}. ${describePending(outcome.pending)}. Inspect with \`${INSPECT_COMMAND}\`.`,
  });
  return { findings, readouts };
}
