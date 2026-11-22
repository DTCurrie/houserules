#!/usr/bin/env node
/**
 * Times a wireit gate: runs `pnpm <script>` at the repo root and names the
 * seconds each wireit script took inside that one run.
 *
 * Usage:
 *   node scripts/time-gate.mjs <script> [--out <path>]
 *
 * Options:
 *   --out <path>  Append the rows to this jsonl file instead of
 *                 `.claude/state/gate-timings.jsonl`.
 *
 * Reads: the output of `pnpm <script>` run with `WIREIT_LOGGER=simple`. That
 * logger prints one line when a script starts (`Running command`) and one when
 * it ends (`Executed successfully`, `Failed`), so the gap between the two is
 * the script's seconds. A script that is fresh, restored from cache, or has no
 * command prints a single line and counts as 0 seconds.
 *
 * Writes: the pnpm output to stderr as it arrives, a table of script, outcome,
 * seconds (slowest first) to stdout after the run, and one JSON row per script
 * to the jsonl file, creating its directory. Each row holds `ts` (run start,
 * ISO), `gate`, `script`, `outcome` and `seconds`.
 *
 * Exit codes: pnpm's own exit code, or 1 when the arguments are wrong or pnpm
 * does not start.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = resolve(ROOT, '.claude/state/gate-timings.jsonl');

// wireit's simple logger: `<emoji> [<script>] <message>`.
const LINE = /^\S+\s+\[([^\]]+)\]\s+(.*)$/;

/**
 * Attributes seconds to each wireit script named in timestamped log lines.
 *
 * @param {{ arrivedMs: number, text: string }[]} lines Log lines with arrival time in
 *   milliseconds.
 * @returns {{ script: string, outcome: string, seconds: number }[]} One row per
 *   script, slowest first. Outcomes: `ran`, `failed`, `fresh`, `cached`,
 *   `no-command`, and `unfinished` for a script that started and never ended.
 */
export function attributeScriptSeconds(lines) {
  const started = new Map();
  const rows = [];
  let last = 0;
  for (const { arrivedMs, text } of lines) {
    last = Math.max(last, arrivedMs);
    const lineMatch = LINE.exec(stripVTControlCharacters(text).trim());
    if (!lineMatch) continue;
    const [, script, message] = lineMatch;
    if (message.startsWith('Running command')) {
      started.set(script, arrivedMs);
      continue;
    }
    const outcome = endOutcome(message);
    if (!outcome) continue;
    const begin = started.get(script);
    started.delete(script);
    rows.push({
      script,
      outcome,
      seconds:
        begin === undefined
          ? 0
          : roundMillis((arrivedMs - begin) / MILLISECONDS_PER_SECOND),
    });
  }
  for (const [script, begin] of started) {
    rows.push({
      script,
      outcome: 'unfinished',
      seconds: roundMillis((last - begin) / MILLISECONDS_PER_SECOND),
    });
  }
  return rows.sort((a, b) => b.seconds - a.seconds);
}

function endOutcome(message) {
  if (message.startsWith('Executed successfully')) return 'ran';
  if (message.startsWith('Failed')) return 'failed';
  if (message.startsWith('Already fresh')) return 'fresh';
  if (message.startsWith('Restored from cache')) return 'cached';
  if (message.startsWith('No command to execute')) return 'no-command';
  return null;
}

const MILLISECONDS_PER_SECOND = 1000;
/** Seconds keep 3 decimals, a millisecond, the resolution of an arrival timestamp. */
const SECONDS_ROUNDING_FACTOR = 1000;
const OUTCOME_COLUMN_WIDTH = 10;

function roundMillis(value) {
  return Math.round(value * SECONDS_ROUNDING_FACTOR) / SECONDS_ROUNDING_FACTOR;
}

function parseArgs(argv) {
  let out = DEFAULT_OUT;
  let script;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = resolve(argv[++i] ?? '');
    else if (!script && !argv[i].startsWith('--')) script = argv[i];
    else return null;
  }
  return script ? { script, out } : null;
}

/** Collects a stream's complete lines into `lines`, each stamped with its arrival time. */
function captureLines(stream, lines) {
  let pending = '';
  stream.on('data', (chunk) => {
    const arrivedMs = Date.now();
    process.stderr.write(chunk);
    pending += chunk.toString();
    const parts = pending.split('\n');
    pending = parts.pop();
    for (const text of parts) lines.push({ arrivedMs, text });
  });
  stream.on('end', () => {
    if (pending) lines.push({ arrivedMs: Date.now(), text: pending });
  });
}

/** Prints the table and appends one jsonl row per script to `out`. */
function writeRows(rows, { script, out }, startedAt) {
  const runStartedAtIso = new Date(startedAt).toISOString();
  process.stdout.write(table(rows));
  mkdirSync(dirname(out), { recursive: true });
  appendFileSync(
    out,
    rows
      .map(
        (row) =>
          JSON.stringify({ ts: runStartedAtIso, gate: script, ...row }) + '\n',
      )
      .join(''),
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write('usage: time-gate.mjs <script> [--out <path>]\n');
    process.exit(1);
  }
  const startedAt = Date.now();
  const lines = [];
  const child = spawn('pnpm', [args.script], {
    cwd: ROOT,
    env: { ...process.env, WIREIT_LOGGER: 'simple' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  captureLines(child.stdout, lines);
  captureLines(child.stderr, lines);
  child.on('error', (err) => {
    process.stderr.write(`time-gate: cannot start pnpm: ${err.message}\n`);
    process.exit(1);
  });
  child.on('close', (code) => {
    writeRows(attributeScriptSeconds(lines), args, startedAt);
    process.exit(code ?? 1);
  });
}

function table(rows) {
  const width = Math.max(
    'script'.length,
    ...rows.map((row) => row.script.length),
  );
  const body = rows.map(
    (row) =>
      `${row.script.padEnd(width)}  ${row.outcome.padEnd(OUTCOME_COLUMN_WIDTH)}  ${row.seconds.toFixed(2)}`,
  );
  return [
    `${'script'.padEnd(width)}  ${'outcome'.padEnd(OUTCOME_COLUMN_WIDTH)}  seconds`,
    ...body,
  ]
    .concat('')
    .join('\n');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
