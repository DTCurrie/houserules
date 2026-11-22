import { join } from 'node:path';

/** The five claims the orchestrate-report check judges, in `verdict.json` key order. */
export const CLAIM_IDS = Object.freeze([
  'agent-059',
  'agent-062',
  'orch-001',
  'orch-042',
  'orch-071',
]);

/** The plan the named-plan prompt runs, and the decoy the no-slug session must leave alone. */
export const FIXTURE_PLAN = 'eval-fixture';
export const DECOY_PLAN = 'decoy';

/** The line the fixture `CLAUDE.md` carries, which preflight probe (a) asks the model to quote. */
export const FIXTURE_TOKEN = 'HR-EVAL-TOKEN-4417';

/** The prompt each named-plan sample sends, and the one the no-slug session sends. */
export const SAMPLE_PROMPT = `/orchestrate ${FIXTURE_PLAN} 1 --auto`;
export const NO_SLUG_PROMPT = '/orchestrate --auto';

/** The dispatcher model every opus session pins. */
export const SAMPLE_MODEL = 'claude-opus-5-5';

/** File names inside one session directory under `--out`. */
export const STREAM = 'stream.jsonl';
export const STDERR = 'stderr.txt';
export const RUN_JSON = 'run.json';
export const TRANSCRIPTS = 'transcripts';

/** File names directly under `--out`. */
export const LEDGER = 'spend.jsonl';
export const LOCK = '.lock';
export const VERDICT = 'verdict.json';

/**
 * Which session a ledger line, a `run.json`, or a session directory belongs to. Exactly one
 * field is set.
 *
 * @typedef {{ sample: number } | { probe: 'a' | 'b' } | { noSlug: true } | ArmKey} SessionKey
 */

/**
 * One arm sample under `--fixture`: the arm's name, then its sample number. Its artifacts sit at
 * `<out>/<arm>/sample-<k>/`, and its ledger line carries both fields.
 *
 * @typedef {{ arm: string, sample: number }} ArmKey
 */

/**
 * One overlaid file in an arm's `run.json` `overlays`. `path` is relative to the sample's
 * `.claude/`. `exitSha256` is null when the session deleted the file. A sample whose
 * `exitSha256` differs from its `overlaySha256` is void.
 *
 * @typedef {{ path: string, initSha256: string, overlaySha256: string, exitSha256: string | null }} OverlayRecord
 */

/**
 * `<out>/<arm>/sample-<k>/run.json`, written after an arm session exits. It carries no left-tree
 * fields, and `prompt` is the full `-p` text.
 *
 * @typedef {ArmKey & {
 *   claudeVersion: string,
 *   commit: string,
 *   stamp: string,
 *   root: string,
 *   prompt: string,
 *   model: string,
 *   validityAgent: string,
 *   exitCode: number | null,
 *   timedOut: boolean,
 *   sessionId: string | null,
 *   apiKeySource: string | null,
 *   overlays: OverlayRecord[],
 * }} ArmRunRecord
 */

/**
 * One line of `<out>/spend.jsonl`: the session key's one field, then the session id (null when
 * the session printed none) and the dollars charged.
 *
 * @typedef {SessionKey & { sessionId: string | null, costUsd: number }} LedgerLine
 */

/**
 * What the left tree showed after a session exited, read by `assemble.mjs` `readLeftTree`.
 *
 * @typedef {object} LeftTree
 * @property {Record<string, number>} acceptances Each fixture step's acceptance exit code on a
 *   rerun in the left tree, keyed by step name. Always three entries.
 * @property {string | null} roadmapPhase1 The fixture ROADMAP's phase 1 line, verbatim, or null.
 * @property {Record<string, boolean>} decoyIntact Each decoy plan file, relative to the decoy
 *   plan directory, and whether it still matches its assembled bytes.
 * @property {boolean} hasDecoyJs Whether `src/decoy.js` exists in the sample root.
 */

/**
 * `<out>/<session dir>/run.json`, written by `run.mjs` after each child session exits.
 *
 * @typedef {SessionKey & {
 *   claudeVersion: string,
 *   commit: string,
 *   stamp: string,
 *   root: string,
 *   prompt: string,
 *   exitCode: number | null,
 *   timedOut: boolean,
 *   sessionId: string | null,
 *   leftTree: LeftTree | null,
 * }} RunRecord
 */

/**
 * The directory name a session's artifacts sit in under `--out`: `sample-<k>`, `no-slug`, or
 * `probe-<a|b>`.
 *
 * @param {SessionKey} key
 * @returns {string}
 */
export function sessionDirName(key) {
  if ('sample' in key) return `sample-${key.sample}`;
  if ('probe' in key) return `probe-${key.probe}`;
  return 'no-slug';
}

/**
 * @param {string} out
 * @param {SessionKey} key
 * @returns {string}
 */
export function sessionDir(out, key) {
  return join(out, sessionDirName(key));
}

/**
 * The directory an arm sample's artifacts sit in: `<out>/<arm>/sample-<k>/`.
 *
 * @param {string} out
 * @param {ArmKey} key
 * @returns {string}
 */
export function armSessionDir(out, key) {
  return join(out, key.arm, sessionDirName({ sample: key.sample }));
}
