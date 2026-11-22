import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';

import { lookupModelPrice } from '../../packages/cli/src/commands/report/model-prices.ts';
import { FIXTURE_TOKEN } from './layout.mjs';

/** The `--per-run` cap preflight's two haiku probes run under, and probe (b) must reach. */
export const PROBE_CAP_USD = 0.02;

const TOKENS_PER_MILLION = 1_000_000;
/** Cache-write price as a multiple of the input price, for the 5-minute and 1-hour TTLs. */
const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
/** The reported-to-priced cost ratios probe (b) accepts as a match. */
const MATCH_RATIO_MIN = 0.9;
const MATCH_RATIO_MAX = 1.25;
/** Float noise is rounded off at this many decimal places before the margin's ceiling. */
const MARGIN_ROUNDING_SCALE = 1e6;
/** The margin moves in steps of a tenth of the cap. */
const MARGIN_STEPS_PER_UNIT = 10;

/** The prompt probe (a) sends: quote the fixture CLAUDE.md token. */
export const PROBE_A_PROMPT =
  'The repo CLAUDE.md carries one line holding an eval token that starts with HR-EVAL-TOKEN. ' +
  'Reply with that token exactly as written and nothing else. Use no tools.';

/** The prompt probe (b) sends: spawn one general-purpose subagent that echoes 1 to 150. */
export const PROBE_B_PROMPT =
  'Your first action is to spawn exactly one subagent with subagent_type "general-purpose". ' +
  'Tell it to run `echo <n>` in Bash for every n from 1 to 150, in order, one Bash call per ' +
  'turn, never batching calls, and to stop after `echo 150`. Do nothing else yourself ' +
  'before spawning it. When it finishes, reply with the word done.';

/**
 * The sha256 of every file `.claude/houserules.manifest.json` lists, keyed by its path.
 *
 * @param {string} root
 * @returns {Record<string, string>}
 */
export function manifestHashes(root) {
  const manifest = JSON.parse(
    readFileSync(join(root, '.claude', 'houserules.manifest.json'), 'utf8'),
  );
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const path of Object.keys(manifest.files ?? {})) {
    try {
      hashes[path] = createHash('sha256')
        .update(readFileSync(join(root, path)))
        .digest('hex');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      hashes[path] = 'missing';
    }
  }
  return hashes;
}

/**
 * `pathValue` with every directory that holds a `houserules` binary dropped.
 *
 * @param {string} pathValue
 * @returns {string}
 */
export function pathWithoutHouserules(pathValue) {
  return pathValue
    .split(delimiter)
    .filter((dir) => {
      if (!dir) return true;
      try {
        const binary = join(dir, 'houserules');
        if (!statSync(binary).isFile()) return true;
        accessSync(binary, constants.X_OK);
        return false;
      } catch {
        return true;
      }
    })
    .join(delimiter);
}

/**
 * Judges probe (a): the reply quotes the token and no manifest file changed.
 *
 * @param {{ resultEvent: object | null, before: Record<string, string>, after: Record<string, string> }} options
 * @returns {{ pass: boolean, isQuoted: boolean, fileCount: number, rewritten: string[] }}
 */
export function judgeProbeA(options) {
  const { resultEvent, before, after } = options;
  const text =
    typeof resultEvent?.result === 'string' ? resultEvent.result : '';
  const isQuoted = text.includes(FIXTURE_TOKEN);
  const fileCount = Object.keys(before).length;
  const rewritten = Object.keys(before).filter(
    (path) => after[path] !== before[path],
  );
  return {
    pass: isQuoted && fileCount > 0 && rewritten.length === 0,
    isQuoted,
    fileCount,
    rewritten,
  };
}

/**
 * Every assistant message with a `usage` record under a directory's `*.jsonl` files, each
 * message id once.
 *
 * @param {string} dir
 * @returns {Array<{ model: string, usage: any }>}
 */
function collectAssistantUsage(dir) {
  /** @type {Map<string, { model: string, usage: any }>} */
  const messages = new Map();
  for (const file of jsonlFiles(dir)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const message = record?.message;
      if (record?.type !== 'assistant' || !message?.usage || !message.model) {
        continue;
      }
      const key = message.id ?? `${file}:${messages.size}`;
      messages.set(key, { model: message.model, usage: message.usage });
    }
  }
  return [...messages.values()];
}

/**
 * List-price dollars for one message's usage.
 *
 * @param {string} model
 * @param {any} usage
 * @returns {number}
 */
function priceMessage(model, usage) {
  const price = lookupModelPrice(model);
  if (!price) throw new Error(`no price row for model ${model}`);
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const writeAll = usage.cache_creation_input_tokens ?? 0;
  const write5m = Math.max(writeAll - write1h, 0);
  return (
    ((usage.input_tokens ?? 0) * price.input +
      (usage.output_tokens ?? 0) * price.output +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      price.input *
        (write5m * CACHE_WRITE_5M_MULTIPLIER +
          write1h * CACHE_WRITE_1H_MULTIPLIER)) /
    TOKENS_PER_MILLION
  );
}

/**
 * List-price dollars over every assistant `usage` record in a session's copied transcripts,
 * main and subagent, each message id counted once.
 *
 * @param {string} transcriptsDir `<out>/probe-b/transcripts/`.
 * @returns {number}
 */
export function priceTranscripts(transcriptsDir) {
  let total = 0;
  for (const { model, usage } of collectAssistantUsage(transcriptsDir)) {
    total += priceMessage(model, usage);
  }
  return total;
}

/**
 * Judges probe (b) and derives the margin.
 *
 * @param {{ resultEvent: object | null, pricedUsd: number }} options
 * @returns {{ pass: boolean, hasReachedCap: boolean, isBudgetStop: boolean, isMatch: boolean, ratio: number | null, margin: number | null }}
 */
export function judgeProbeB(options) {
  const { resultEvent, pricedUsd } = options;
  const total = resultEvent?.total_cost_usd;
  const hasTotal = typeof total === 'number';
  const hasReachedCap = hasTotal && total >= PROBE_CAP_USD;
  const isBudgetStop = /budget/i.test(String(resultEvent?.subtype ?? ''));
  const ratio = hasTotal && pricedUsd > 0 ? total / pricedUsd : null;
  const isMatch =
    ratio !== null && ratio >= MATCH_RATIO_MIN && ratio <= MATCH_RATIO_MAX;
  let margin = null;
  if (hasTotal) {
    // Round away float noise before the ceiling: (0.024 - 0.02) / 0.02 is 0.2000000000000002.
    const tenths =
      Math.round(
        ((total - PROBE_CAP_USD) / PROBE_CAP_USD) *
          MARGIN_STEPS_PER_UNIT *
          MARGIN_ROUNDING_SCALE,
      ) / MARGIN_ROUNDING_SCALE;
    margin = Math.max(Math.ceil(tenths), 1) / MARGIN_STEPS_PER_UNIT;
  }
  return {
    pass: (hasReachedCap || isBudgetStop) && isMatch,
    hasReachedCap,
    isBudgetStop,
    isMatch,
    ratio,
    margin,
  };
}

/** Every `*.jsonl` under a directory, recursively. */
function jsonlFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...jsonlFiles(path));
    else if (entry.name.endsWith('.jsonl')) found.push(path);
  }
  return found;
}
