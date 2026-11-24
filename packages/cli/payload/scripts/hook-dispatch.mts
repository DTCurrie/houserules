#!/usr/bin/env node
/**
 * The single hook command each dispatched event's settings entry runs. It reads the hook
 * payload from stdin, takes the event from `hook_event_name`, and runs every hook
 * `.claude/scripts/hook-wiring.json` lists for that event whose matcher selects the input, in
 * parallel, each with the same stdin bytes, the inherited env, and this process's cwd.
 *
 * The wiring is read from `$CLAUDE_PROJECT_DIR`, else from the repo root.
 *
 * Exit codes:
 * - 2 when any hook exited 2. Those hooks' stderr is written in wiring order.
 * - 1 when a hook marked `onFailure: 'block'` failed (non-zero exit, timeout, spawn error,
 *   or absent script), with its stderr or a one-line notice.
 * - A hook not marked `onFailure: 'block'` that exits with a code other than 0 or 2 and writes
 *   a JSON object to stdout counts as successful, as the harness reads it.
 * - 1 when any other hook failed, no entry of the event blocks, and no successful hook wrote
 *   stdout. A blocking settings entry would turn that exit into a block, and the harness
 *   ignores stdout on exit 1. Otherwise the failure is written and the dispatcher exits 0.
 *   An absent non-blocking script is skipped silently.
 * - 1 when the wiring file is missing, unparsable, or not version 1.
 * - 0 otherwise, including for an event the wiring does not list. The selected hooks' stdout
 *   is passed through, or merged when more than one wrote any.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRoot } from '@houserules/payload/proc';

/** Mirrors `HOOK_WIRING_PATH` in `@houserules/api`, which payload code cannot import. */
const WIRING_PATH = '.claude/scripts/hook-wiring.json';
const WIRING_VERSION = 1;
const SCRIPTS_DIR = '.claude/scripts';
/** Mirrors `HOOK_RUNS_LOG_PATH` in the CLI's `hook-runs-log.ts`, which payload code cannot import. */
const RUNS_LOG_PATH = '.claude/state/hook-runs.jsonl';
/** Mirrors `HOOK_RUNS_ROTATED_PATH` in the CLI's `hook-runs-log.ts`. */
const RUNS_ROTATED_PATH = '.claude/state/hook-runs.1.jsonl';
/** The size, in bytes, past which the log rotates before an append: 1 MiB. */
const RUNS_LOG_CAP_BYTES = 1024 * 1024;
const NOTICE_PREFIX = '[houserules] hook-dispatch:';
/** The harness's own default for a command hook with no `timeout`. */
const DEFAULT_TIMEOUT_SECONDS = 600;
/**
 * The events on which the harness lowers that default, in seconds. Mirrors
 * `EVENT_TIMEOUT_SECONDS` in the CLI's `plan.ts`, which payload code cannot import.
 */
const EVENT_TIMEOUT_SECONDS: Readonly<Record<string, number>> = {
  UserPromptSubmit: 30,
  PreModelSwitch: 30,
  PostModelSwitch: 30,
  MessageDisplay: 10,
};
/**
 * Seconds a hook's default stops short of the harness's, so the dispatcher can still merge and
 * exit before the harness kills it and discards every hook's output.
 */
const TIMEOUT_MARGIN_SECONDS = 2;
/** How long a hook's open stdio is waited on after the hook itself exits, as the harness waits. */
const STDIO_GRACE_MILLISECONDS = 10_000;
const MILLISECONDS_PER_SECOND = 1000;
const BLOCKING_EXIT = 2;
const FAILURE_EXIT = 1;
const BLOCK_DECISION_RANK = 1;

/** One dispatched hook, the shape of `HookWiringEntry` in `@houserules/api`. */
export interface WiringEntry {
  script: string;
  matcher?: string;
  timeout?: number;
  onFailure?: 'block';
  statusMessage?: string;
}

interface Wiring {
  version: 1;
  events: Record<string, unknown>;
}

/** How one hook run ended. `hasSucceeded` says which of these count as success. */
type HookOutcome =
  | { kind: 'exited'; code: number }
  | { kind: 'signal'; signal: string }
  | { kind: 'timeout'; seconds: number }
  | { kind: 'spawn-error'; message: string }
  | { kind: 'missing' };

export interface HookResult {
  entry: WiringEntry;
  outcome: HookOutcome;
  stdout: string;
  stderr: string;
  /** Wall time from spawn to settle, in milliseconds. */
  durationMilliseconds: number;
}

interface Verdict {
  code: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

type JsonObject = Record<string, unknown>;

/** The input field each event's matcher is tested against. Any other event ignores matchers. */
const MATCH_FIELDS: Readonly<Record<string, string>> = {
  PreToolUse: 'tool_name',
  PostToolUse: 'tool_name',
  PostToolUseFailure: 'tool_name',
  PermissionRequest: 'tool_name',
  SessionStart: 'source',
  SessionEnd: 'reason',
  PreCompact: 'trigger',
  Notification: 'notification_type',
};

const EXACT_LIST_RE = /^[A-Za-z0-9_|]+$/;

/** Restrictiveness of a `permissionDecision`. Higher wins a merge. */
const DECISION_RANK: Readonly<Record<string, number>> = {
  allow: 1,
  ask: 2,
  defer: 3,
  deny: 4,
};

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a harness-syntax matcher selects `value`. Absent, empty, or `*` selects everything.
 * Only letters, digits, `_`, and `|` is an exact list. Anything else is a regex over the whole
 * value, and an invalid one selects nothing.
 */
export function matcherSelects(
  matcher: string | undefined,
  value: string,
): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (EXACT_LIST_RE.test(matcher)) return matcher.split('|').includes(value);
  try {
    return new RegExp(`^(?:${matcher})$`).test(value);
  } catch {
    return false;
  }
}

/** The entries of `event` whose matcher selects `input`, in wiring order. */
export function selectEntries(
  entries: WiringEntry[],
  event: string,
  input: JsonObject,
): WiringEntry[] {
  if (!Object.hasOwn(MATCH_FIELDS, event)) return entries;
  const field = MATCH_FIELDS[event]!;
  const raw = input[field];
  const value = typeof raw === 'string' ? raw : '';
  return entries.filter((entry) => matcherSelects(entry.matcher, value));
}

function isWiringEntry(value: unknown): value is WiringEntry {
  if (!isJsonObject(value)) return false;
  if (typeof value['script'] !== 'string' || value['script'] === '')
    return false;
  return value['matcher'] === undefined || typeof value['matcher'] === 'string';
}

/** The parsed wiring file, or null when it is missing, unparsable, or not version 1. */
function readWiring(path: string): Wiring | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isJsonObject(parsed) || parsed['version'] !== WIRING_VERSION)
      return null;
    if (!isJsonObject(parsed['events'])) return null;
    return { version: WIRING_VERSION, events: parsed['events'] };
  } catch {
    return null;
  }
}

/** The event's well-formed entries, or null when the wiring does not list the event. */
function entriesFor(wiring: Wiring, event: string): WiringEntry[] | null {
  if (!Object.hasOwn(wiring.events, event)) return null;
  const listed = wiring.events[event];
  return Array.isArray(listed) ? listed.filter(isWiringEntry) : [];
}

/**
 * The entry's `timeout` in seconds. When it is absent or invalid, the harness default for
 * `event` less a margin.
 */
export function timeoutSecondsFor(entry: WiringEntry, event: string): number {
  const { timeout } = entry;
  if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0)
    return timeout;
  const harnessDefault = Object.hasOwn(EVENT_TIMEOUT_SECONDS, event)
    ? EVENT_TIMEOUT_SECONDS[event]!
    : DEFAULT_TIMEOUT_SECONDS;
  return harnessDefault - TIMEOUT_MARGIN_SECONDS;
}

/**
 * Collects a child's output and settles once with how it ended. A child that exits while its
 * own children hold its pipes open settles `graceMilliseconds` after the exit, with the output
 * read so far.
 */
export function awaitChild(
  child: ChildProcess,
  entry: WiringEntry,
  seconds: number,
  graceMilliseconds: number,
): Promise<HookResult> {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let isSettled = false;
    let hasTimedOut = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const settle = (outcome: HookOutcome): void => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve({
        entry,
        outcome,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMilliseconds: Math.max(0, performance.now() - startedAt),
      });
    };
    const timer = setTimeout(() => {
      hasTimedOut = true;
      child.kill('SIGKILL');
    }, seconds * MILLISECONDS_PER_SECOND);
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) =>
      settle({ kind: 'spawn-error', message: error.message }),
    );
    const closePipes = (): void => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const outcomeOf = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): HookOutcome => {
      if (hasTimedOut) return { kind: 'timeout', seconds };
      if (code !== null) return { kind: 'exited', code };
      return { kind: 'signal', signal: String(signal) };
    };
    // A hook's own children can hold its pipes open, so `close` may never follow `exit`.
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (hasTimedOut) {
        closePipes();
        return settle(outcomeOf(code, signal));
      }
      graceTimer = setTimeout(() => {
        closePipes();
        settle(outcomeOf(code, signal));
      }, graceMilliseconds);
    });
    child.on('close', (code, signal) => settle(outcomeOf(code, signal)));
  });
}

/** Runs one hook script of `event` under `root` with `stdin`, killing it past its timeout. */
function runHook(
  root: string,
  entry: WiringEntry,
  event: string,
  stdin: Buffer,
): Promise<HookResult> {
  const path = join(root, SCRIPTS_DIR, entry.script);
  if (!existsSync(path)) {
    return Promise.resolve({
      entry,
      outcome: { kind: 'missing' },
      stdout: '',
      stderr: '',
      durationMilliseconds: 0,
    });
  }
  try {
    const child = spawn(process.execPath, [path], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = awaitChild(
      child,
      entry,
      timeoutSecondsFor(entry, event),
      STDIO_GRACE_MILLISECONDS,
    );
    // A hook that exits without reading stdin closes the pipe under us. That is not a failure.
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Promise.resolve({
      entry,
      outcome: { kind: 'spawn-error', message },
      stdout: '',
      stderr: '',
      durationMilliseconds: 0,
    });
  }
}

/**
 * Whether the harness would read the hook's stdout. Exit 0 always. Any other exit but 2 when
 * stdout is a JSON object, unless the hook is marked `onFailure: 'block'`.
 */
function hasSucceeded(result: HookResult): boolean {
  const { outcome, entry } = result;
  if (outcome.kind !== 'exited') return false;
  if (outcome.code === 0) return true;
  if (outcome.code === BLOCKING_EXIT || entry.onFailure === 'block')
    return false;
  return parseObject(result.stdout) !== null;
}

function reasonFor(outcome: HookOutcome): string {
  switch (outcome.kind) {
    case 'exited':
      return `exited ${outcome.code}`;
    case 'signal':
      return `was killed by ${outcome.signal}`;
    case 'timeout':
      return `timed out after ${outcome.seconds}s`;
    case 'spawn-error':
      return 'failed to start';
    case 'missing':
      return 'is missing';
    default: {
      const unreachable: never = outcome;
      return String(unreachable);
    }
  }
}

function endWithNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * A failed hook's stderr, after one line naming the script and why it failed. `houserules
 * report` keys on that line, since every settings command now names only the dispatcher.
 */
function failureText(result: HookResult): string {
  const notice = `${NOTICE_PREFIX} ${result.entry.script} ${reasonFor(result.outcome)}\n`;
  const detail =
    result.outcome.kind === 'spawn-error'
      ? result.outcome.message
      : result.stderr;
  return detail.trim() === '' ? notice : `${notice}${endWithNewline(detail)}`;
}

/**
 * The dispatcher's exit code and output for the hooks' results, given in wiring order.
 * `eventHasBlock` is whether any entry of the event, selected or not, carries
 * `onFailure: 'block'`, since then the settings entry blocks on exit 1.
 */
export function verdictFor(
  results: HookResult[],
  event: string,
  eventHasBlock: boolean,
): Verdict {
  const refusals = results.filter(
    (result) =>
      result.outcome.kind === 'exited' && result.outcome.code === BLOCKING_EXIT,
  );
  if (refusals.length > 0) {
    const stderr = refusals
      .filter((result) => result.stderr !== '')
      .map((result) => endWithNewline(result.stderr))
      .join('');
    return { code: BLOCKING_EXIT, stdout: '', stderr };
  }
  const failed = results.filter((result) => !hasSucceeded(result));
  const blockFailures = failed.filter(
    (result) => result.entry.onFailure === 'block',
  );
  if (blockFailures.length > 0) {
    return {
      code: FAILURE_EXIT,
      stdout: '',
      stderr: blockFailures.map(failureText).join(''),
    };
  }
  const reported = failed.filter((result) => result.outcome.kind !== 'missing');
  const stderr = reported.map(failureText).join('');
  const stdout = mergeStdout(
    results.filter(hasSucceeded).map((result) => result.stdout),
    event,
  );
  // The harness ignores stdout on exit 1, so a sibling's output keeps the exit at 0.
  if (reported.length > 0 && !eventHasBlock && stdout === '') {
    return { code: FAILURE_EXIT, stdout: '', stderr };
  }
  return { code: 0, stdout, stderr };
}

function parseObject(text: string): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stripTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function joinContext(existing: unknown, addition: string): string {
  return typeof existing === 'string' ? `${existing}\n${addition}` : addition;
}

/** A decision field the merge resolves by restrictiveness rather than by wiring order. */
interface RankedField {
  key: string;
  reasonKey: string | null;
  rank: (value: unknown) => number;
}

function permissionRank(decision: unknown): number {
  return typeof decision === 'string' && Object.hasOwn(DECISION_RANK, decision)
    ? DECISION_RANK[decision]!
    : 0;
}

function blockRank(decision: unknown): number {
  return decision === 'block' ? BLOCK_DECISION_RANK : 0;
}

function behaviorRank(decision: unknown): number {
  if (!isJsonObject(decision)) return 0;
  return permissionRank(decision['behavior']);
}

const TOP_LEVEL_DECISION: RankedField = {
  key: 'decision',
  reasonKey: 'reason',
  rank: blockRank,
};
const SPECIFIC_DECISIONS: readonly RankedField[] = [
  {
    key: 'permissionDecision',
    reasonKey: 'permissionDecisionReason',
    rank: permissionRank,
  },
  { key: 'decision', reasonKey: null, rank: behaviorRank },
];

function isRankedKey(fields: readonly RankedField[], key: string): boolean {
  return fields.some((field) => field.key === key || field.reasonKey === key);
}

/**
 * Takes `next`'s value of a ranked field, with its reason, when it is at least as restrictive
 * as the one already merged, so a reason always travels with the decision it explains. A
 * reason with no decision beside it applies only while no decision is merged.
 */
function mergeRanked(
  merged: JsonObject,
  next: JsonObject,
  field: RankedField,
): void {
  const { key, reasonKey, rank } = field;
  if (!(key in next)) {
    if (reasonKey && reasonKey in next && !(key in merged))
      merged[reasonKey] = next[reasonKey];
    return;
  }
  if (key in merged && rank(next[key]) < rank(merged[key])) return;
  merged[key] = next[key];
  if (!reasonKey) return;
  if (reasonKey in next) merged[reasonKey] = next[reasonKey];
  else delete merged[reasonKey];
}

/** Field-wise merge of two `hookSpecificOutput` objects. */
function mergeSpecific(merged: JsonObject, next: JsonObject): JsonObject {
  const out = { ...merged };
  for (const [key, value] of Object.entries(next)) {
    if (isRankedKey(SPECIFIC_DECISIONS, key)) continue;
    out[key] =
      key === 'additionalContext' && typeof value === 'string'
        ? joinContext(out[key], value)
        : value;
  }
  for (const field of SPECIFIC_DECISIONS) mergeRanked(out, next, field);
  return out;
}

/**
 * Shallow-merges hook JSON outputs in order. `continue: false` and `decision: "block"` from any
 * of them win.
 */
function mergeObjects(objects: JsonObject[]): JsonObject {
  const merged: JsonObject = {};
  let specific: JsonObject | null = null;
  let isStopped = false;
  for (const object of objects) {
    const { hookSpecificOutput, ...topLevel } = object;
    for (const [key, value] of Object.entries(topLevel)) {
      if (!isRankedKey([TOP_LEVEL_DECISION], key)) merged[key] = value;
    }
    mergeRanked(merged, object, TOP_LEVEL_DECISION);
    if (object['continue'] === false) isStopped = true;
    if (isJsonObject(hookSpecificOutput)) {
      specific = mergeSpecific(specific ?? {}, hookSpecificOutput);
    }
  }
  if (isStopped) merged['continue'] = false;
  if (specific) merged['hookSpecificOutput'] = specific;
  return merged;
}

function appendText(merged: JsonObject, text: string, event: string): void {
  const existing = merged['hookSpecificOutput'];
  const specific: JsonObject = isJsonObject(existing) ? { ...existing } : {};
  specific['hookEventName'] = event;
  specific['additionalContext'] = joinContext(
    specific['additionalContext'],
    text,
  );
  merged['hookSpecificOutput'] = specific;
}

/**
 * The dispatcher's stdout from the successful hooks' stdout, in wiring order. One non-empty
 * output passes through byte for byte. Several JSON objects merge. Several texts join with a
 * newline. A mix merges the JSON and appends the text to its `additionalContext`.
 */
export function mergeStdout(outputs: string[], event: string): string {
  const parts = outputs.filter((output) => output.trim() !== '');
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  const objects: JsonObject[] = [];
  const texts: string[] = [];
  for (const part of parts) {
    const parsed = parseObject(part);
    if (parsed) objects.push(parsed);
    else texts.push(stripTrailingNewline(part));
  }
  const text = texts.join('\n');
  if (objects.length === 0) return `${text}\n`;
  const merged = mergeObjects(objects);
  if (texts.length > 0) appendText(merged, text, event);
  return `${JSON.stringify(merged)}\n`;
}

function readStdinBytes(): Buffer {
  try {
    return readFileSync(0);
  } catch {
    return Buffer.alloc(0);
  }
}

function eventOf(input: JsonObject): string {
  const event = input['hook_event_name'];
  return typeof event === 'string' ? event : '';
}

function projectRoot(): string {
  return process.env['CLAUDE_PROJECT_DIR'] || repoRoot();
}

function emit(verdict: Verdict): void {
  if (verdict.stdout !== '') process.stdout.write(verdict.stdout);
  if (verdict.stderr !== '') process.stderr.write(verdict.stderr);
  process.exitCode = verdict.code;
}

/** One JSONL line for a settled hook, the shape of `HookRunRecord` in the CLI's `hook-runs-log.ts`. */
function runLine(event: string, result: HookResult): string {
  const { outcome } = result;
  return `${JSON.stringify({
    at: new Date().toISOString(),
    event,
    script: result.entry.script,
    exitCode: outcome.kind === 'exited' ? outcome.code : null,
    hasOutput: result.stdout !== '' || result.stderr !== '',
    durationMilliseconds: result.durationMilliseconds,
  })}\n`;
}

/**
 * Appends one line per result to the run log, rotating it first when it is past the cap. Every
 * failure is swallowed, since a hook must never change its verdict or print over its own bookkeeping.
 */
function recordRuns(root: string, event: string, results: HookResult[]): void {
  if (results.length === 0) return;
  try {
    const logPath = join(root, RUNS_LOG_PATH);
    mkdirSync(dirname(logPath), { recursive: true });
    try {
      if (statSync(logPath).size > RUNS_LOG_CAP_BYTES) {
        renameSync(logPath, join(root, RUNS_ROTATED_PATH));
      }
    } catch {
      // No log yet, or it could not rotate. The append below decides.
    }
    appendFileSync(
      logPath,
      results.map((result) => runLine(event, result)).join(''),
    );
  } catch {
    // Bookkeeping only.
  }
}

async function dispatch(): Promise<Verdict> {
  const stdin = readStdinBytes();
  const input = parseObject(stdin.toString('utf8')) ?? {};
  const event = eventOf(input);
  const root = projectRoot();
  const wiringPath = join(root, WIRING_PATH);
  const wiring = readWiring(wiringPath);
  if (!wiring) {
    const stderr = `${NOTICE_PREFIX} ${wiringPath} is missing or unreadable. Run houserules update.\n`;
    return { code: FAILURE_EXIT, stdout: '', stderr };
  }
  const entries = entriesFor(wiring, event);
  if (!entries) return { code: 0, stdout: '', stderr: '' };
  const selected = selectEntries(entries, event, input);
  const results = await Promise.all(
    selected.map((entry) => runHook(root, entry, event, stdin)),
  );
  recordRuns(root, event, results);
  const eventHasBlock = entries.some((entry) => entry.onFailure === 'block');
  return verdictFor(results, event, eventHasBlock);
}

async function main(): Promise<void> {
  try {
    emit(await dispatch());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit({
      code: FAILURE_EXIT,
      stdout: '',
      stderr: `${NOTICE_PREFIX} ${message}\n`,
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  void main();
}
