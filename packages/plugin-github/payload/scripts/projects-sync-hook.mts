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
 *
 * Before the empty check it holds back every ledger row this session wrote in a turn where the
 * user rejected a tool use, read from the `session_id` and `transcript_path` on stdin. Held ids
 * go to `.claude/state/projects-sync-holds.json`, which `projects-sync.mjs status` lists and
 * `projects-sync.mjs release <id>` clears. The hook never writes a ledger.
 *
 * The push it spawns gets `--session <session_id>`, so it sends this session's rows and leaves
 * an entry queued while it holds a row another session wrote less than 24 hours ago. That other
 * session's own end pushes it, or any session's end once the row is a day old. The empty check
 * applies the same rule, so a session whose queue is only another live session's rows spawns
 * nothing.
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

import { readStdinJson } from '@houserules/payload/proc';
import { loadConfigSafe, repoRoot } from '@houserules/payload/config';
import { ledgerDir, readLog } from '@houserules/payload/entry-ledger';
import { ENABLE_TOKEN_BASENAME } from './lib/sync-gate.mjs';
import {
  buildPushQueue,
  entriesLeftForOtherSessions,
  summarizeQueue,
  withoutHeldEntries,
} from './lib/push-queue.mjs';
import type { LedgerRecord } from './lib/push-queue.mjs';
import { pushLockIsHeld, pushLockPath } from './lib/push-lock.mjs';
import {
  USER_REJECTION_TEXT,
  rejectedTurnWindows,
  rowsInRejectedTurns,
} from './lib/rejected-turns.mjs';
import {
  heldIds,
  holdsPath,
  mergeHolds,
  readHolds,
  writeHolds,
} from './lib/sync-holds.mjs';

const BACKLOG_LEDGER_BASENAME = 'backlog.jsonl';
const DECISIONS_LEDGER_BASENAME = 'decisions.jsonl';
const STATE_DIR = '.claude/state';
const LOG_BASENAME = 'projects-sync.log';
const MAX_LOG_BYTES = 256 * 1024;
const KEPT_LOG_BYTES = 64 * 1024;
/** The JSON field a user-rejected tool result carries, as it appears in the raw transcript. */
const USER_REJECTED_MARKER = '"toolDenialKind":"user-rejected"';

/** The fields of the `SessionEnd` stdin payload this hook reads. */
interface HookInput {
  session_id?: string;
  transcript_path?: string;
}

/** Whether a live, fresh push lock exists, so a burst of hooks spawns one push. */
function pushLockHeld(root: string): boolean {
  return pushLockIsHeld(pushLockPath(root));
}

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
function pushQueueEmpty(
  backlog: readonly LedgerRecord[],
  decisions: readonly LedgerRecord[],
  skipped: ReadonlySet<string>,
): boolean {
  const summary = summarizeQueue(
    withoutHeldEntries(buildPushQueue(backlog, decisions), skipped),
  );
  return summary.backlogPending + summary.decisionsPending === 0;
}

/**
 * Every entry this session's push leaves queued: the held ones, plus each one that holds a row
 * another session wrote less than a day ago. With no session id, only the held ones.
 */
function entriesToSkip(
  records: readonly LedgerRecord[],
  held: ReadonlySet<string>,
  sessionId: string | undefined,
): ReadonlySet<string> {
  if (!sessionId) return held;
  return new Set([
    ...held,
    ...entriesLeftForOtherSessions(records, sessionId, new Date()),
  ]);
}

/**
 * The rows this session wrote in a turn where the user rejected a tool use.
 *
 * Reads the transcript only when the session wrote a row at all, and parses it only when its
 * text holds a rejection, so the common session costs one ledger filter and no transcript read.
 */
function rowsToHold(
  records: readonly LedgerRecord[],
  input: HookInput,
): LedgerRecord[] {
  const sessionId = input.session_id;
  if (!sessionId || !input.transcript_path) return [];
  if (!records.some((record) => record.chat === sessionId)) return [];

  const transcript = readFileSync(input.transcript_path, 'utf8');
  if (
    !transcript.includes(USER_REJECTED_MARKER) &&
    !transcript.includes(USER_REJECTION_TEXT)
  )
    return [];

  const windows = rejectedTurnWindows(transcript.split('\n'), sessionId);
  return rowsInRejectedTurns(records, windows, sessionId);
}

/**
 * Records holds for this session's rows from rejected turns, merged into the existing file, and
 * returns every held id. Never writes a ledger: a hold is undone by `projects-sync.mjs release`.
 */
function recordHolds(
  root: string,
  records: readonly LedgerRecord[],
  input: HookInput,
): ReadonlySet<string> {
  const path = holdsPath(root);
  const holds = readHolds(path);
  const rows = rowsToHold(records, input);
  if (rows.length === 0) return heldIds(holds);

  const merged = mergeHolds(holds, rows);
  if (JSON.stringify(merged) !== JSON.stringify(holds))
    writeHolds(path, merged);
  return heldIds(merged);
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

function spawnPush(root: string, sessionId: string | undefined): void {
  const stateDir = resolve(root, STATE_DIR);
  mkdirSync(stateDir, { recursive: true });
  const logFile = resolve(stateDir, LOG_BASENAME);
  capLogFile(logFile);

  const args = [syncScriptPath(), 'push'];
  if (sessionId) args.push('--session', sessionId);
  const logFd = openSync(logFile, 'a');
  try {
    const child = spawn(process.execPath, args, {
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
function run(input: HookInput): void {
  const root = repoRoot();
  const config = loadConfigSafe(root);
  const ledgerDirectory = ledgerDir(root, config.ledgers?.dir);

  if (!hasSyncToken(ledgerDirectory)) return;
  if (autoSyncDisabled(config)) return;
  if (!ledgerFilesExist(ledgerDirectory)) return;

  const backlog = readLog<LedgerRecord>(
    resolve(ledgerDirectory, BACKLOG_LEDGER_BASENAME),
  );
  const decisions = readLog<LedgerRecord>(
    resolve(ledgerDirectory, DECISIONS_LEDGER_BASENAME),
  );
  // Any failure here throws to the catch below and spawns no push, so a rejected row is never
  // pushed because the hold could not be recorded.
  const records = [...backlog, ...decisions];
  const held = recordHolds(root, records, input);
  const skipped = entriesToSkip(records, held, input.session_id);

  if (pushQueueEmpty(backlog, decisions, skipped)) return;
  if (pushLockHeld(root)) return;

  spawnPush(root, input.session_id);
}

try {
  run(readStdinJson<HookInput>());
} catch {
  // A sync attempt must never break session termination.
}
process.exit(0);
