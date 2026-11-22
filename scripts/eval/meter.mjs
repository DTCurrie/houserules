import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { LEDGER, LOCK } from './layout.mjs';

const SPEND_EPSILON = 1e-9;

/**
 * Throws, naming each missing flag, unless `budget`, `perRun`, and `margin` are all finite
 * non-negative numbers. `--paid` has no defaults for them.
 *
 * @param {{ budget?: number, perRun?: number, margin?: number }} options
 */
export function requirePaidFlags(options) {
  const bad = ['budget', 'perRun', 'margin'].filter((name) => {
    const value = options?.[name];
    return typeof value !== 'number' || !Number.isFinite(value) || value < 0;
  });
  if (bad.length > 0) {
    throw new Error(
      `--paid requires finite non-negative values for: ${bad.join(', ')}`,
    );
  }
}

/**
 * The parsed lines of `<out>/spend.jsonl`, or `[]` when it is absent.
 *
 * @param {string} out
 * @returns {import('./layout.mjs').LedgerLine[]}
 */
export function readLedger(out) {
  let text;
  try {
    text = readFileSync(join(out, LEDGER), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * Dollars a session is charged: the result event's `total_cost_usd` when it is a number, else
 * `perRun`.
 *
 * @param {object | null} resultEvent
 * @param {number} perRun
 * @returns {number}
 */
export function chargeFor(resultEvent, perRun) {
  const cost = resultEvent?.total_cost_usd;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : perRun;
}

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * @param {string} lockPath
 * @returns {boolean} Whether the lock was created.
 */
function tryCreateLock(lockPath) {
  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Runs `action` holding `<out>/.lock`, created with the `wx` flag and holding this pid. Throws
 * without calling `action` when the lock's pid is alive. Removes a lock whose pid is dead, then
 * proceeds. Removes its own lock when `action` settles.
 *
 * @template TResult
 * @param {string} out
 * @param {() => Promise<TResult>} action
 * @returns {Promise<TResult>}
 */
export async function withLock(out, action) {
  mkdirSync(out, { recursive: true });
  const lockPath = join(out, LOCK);
  if (!tryCreateLock(lockPath)) {
    const holder = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
    if (Number.isInteger(holder) && isAlive(holder)) {
      throw new Error(`${lockPath} is held by running pid ${holder}`);
    }
    rmSync(lockPath, { force: true });
    if (!tryCreateLock(lockPath))
      throw new Error(`${lockPath} was taken by another run`);
  }
  try {
    return await action();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/**
 * Starts each job in order while the ledger sum plus `perRun * (1 + margin)` is at most
 * `budget`, appending one ledger line per started job. Stops at the first job it refuses.
 *
 * @param {{
 *   out: string,
 *   budget: number,
 *   perRun: number,
 *   margin: number,
 *   jobs: import('./layout.mjs').SessionKey[],
 *   start: (key: import('./layout.mjs').SessionKey) => Promise<{ sessionId: string | null, resultEvent: object | null }>,
 * }} options
 * @returns {Promise<{ started: import('./layout.mjs').LedgerLine[], refused: import('./layout.mjs').SessionKey | null }>}
 */
export async function runMetered({ out, budget, perRun, margin, jobs, start }) {
  mkdirSync(out, { recursive: true });
  let spent = readLedger(out).reduce((sum, line) => sum + line.costUsd, 0);
  const started = [];
  for (const key of jobs) {
    if (spent + perRun * (1 + margin) > budget + SPEND_EPSILON)
      return { started, refused: key };
    const { sessionId, resultEvent } = await start(key);
    const line = { ...key, sessionId, costUsd: chargeFor(resultEvent, perRun) };
    appendFileSync(join(out, LEDGER), `${JSON.stringify(line)}\n`);
    spent += line.costUsd;
    started.push(line);
  }
  return { started, refused: null };
}
