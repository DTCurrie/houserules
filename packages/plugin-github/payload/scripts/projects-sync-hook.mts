#!/usr/bin/env node
/**
 * SessionEnd hook. Fires when a session ends, on `/clear`, and on `/resume`, so it can run
 * several times per CLI process.
 *
 * Never awaits the sync: runs a handful of cheap local checks and, only when every one of them
 * says there is real work, spawns `projects-sync.mjs push` fully detached and returns
 * immediately, inside the shared 1.5 second SessionEnd budget. A contributor who never opted in
 * sees no evidence the integration exists, so every silent-return path writes nothing at all,
 * not even a log line. Always exits 0.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { readStdinJson } from '@agent-kit/payload/proc';
import { loadConfigSafe, repoRoot } from '@agent-kit/payload/kit-config';
import { ledgerDir, readLog } from '@agent-kit/payload/entry-ledger';
import { ENABLE_TOKEN_BASENAME } from './lib/sync-gate.mjs';
import { buildPushQueue, summarizeQueue } from './lib/push-queue.mjs';
import type { LedgerRecord } from './lib/push-queue.mjs';

const BACKLOG_LEDGER_BASENAME = 'backlog.jsonl';
const DECISIONS_LEDGER_BASENAME = 'decisions.jsonl';
const STATE_DIR = '.claude/state';
const LOG_BASENAME = 'projects-sync.log';
const MAX_LOG_BYTES = 256 * 1024;
const KEPT_LOG_BYTES = 64 * 1024;

function hasSyncToken(ledgerDirectory: string): boolean {
  return existsSync(resolve(ledgerDirectory, ENABLE_TOKEN_BASENAME));
}

function autoSyncDisabled(config: ReturnType<typeof loadConfigSafe>): boolean {
  return (
    (config.projects as { autoSync?: boolean } | undefined)?.autoSync === false
  );
}

function ledgerFilesExist(ledgerDirectory: string): boolean {
  return (
    existsSync(resolve(ledgerDirectory, BACKLOG_LEDGER_BASENAME)) ||
    existsSync(resolve(ledgerDirectory, DECISIONS_LEDGER_BASENAME))
  );
}

/**
 * Whether there is nothing to push.
 *
 * Reads the ledgers raw, without decoding each record's gzipped `content`. Which operations the
 * queue emits depends on the actions and on what the `synced` records account for, never on the
 * body text, so counting them does not need the bodies. `projects-sync.mjs` decodes because it
 * publishes those bodies. This only counts, and gunzipping several hundred records inside a hook
 * that shares a 1.5 second budget would be work for no answer.
 */
function pushQueueEmpty(ledgerDirectory: string): boolean {
  const backlog = readLog<LedgerRecord>(
    resolve(ledgerDirectory, BACKLOG_LEDGER_BASENAME),
  );
  const decisions = readLog<LedgerRecord>(
    resolve(ledgerDirectory, DECISIONS_LEDGER_BASENAME),
  );
  const summary = summarizeQueue(buildPushQueue(backlog, decisions));
  return summary.backlogPending + summary.decisionsPending === 0;
}

/**
 * Keeps the log from growing forever. When it crosses {@link MAX_LOG_BYTES}, this rewrites it
 * to just its last {@link KEPT_LOG_BYTES} bytes.
 */
function capLogFile(logFile: string): void {
  if (!existsSync(logFile)) return;
  const size = statSync(logFile).size;
  if (size <= MAX_LOG_BYTES) return;
  const bytes = readFileSync(logFile);
  writeFileSync(logFile, bytes.subarray(bytes.length - KEPT_LOG_BYTES));
}

/** Resolves the sibling `projects-sync.mjs`, which lands next to this file in `.claude/scripts/`. */
function syncScriptPath(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, 'projects-sync.mjs');
}

function spawnPush(root: string): void {
  const stateDir = resolve(root, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const logFile = resolve(stateDir, LOG_BASENAME);
  capLogFile(logFile);

  const logFd = openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, [syncScriptPath(), 'push'], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      cwd: root,
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

// No GitHub permission check here: push already does it, and a network round trip inside the
// hook's shared budget would blow it.
function run(): void {
  const root = repoRoot();
  const config = loadConfigSafe();
  const ledgerDirectory = ledgerDir(root, config.ledgers?.dir);

  if (!hasSyncToken(ledgerDirectory)) return;
  if (autoSyncDisabled(config)) return;
  if (!ledgerFilesExist(ledgerDirectory)) return;
  if (pushQueueEmpty(ledgerDirectory)) return;

  spawnPush(root);
}

try {
  readStdinJson();
  run();
} catch {
  // A sync attempt must never break session termination.
}
process.exit(0);
