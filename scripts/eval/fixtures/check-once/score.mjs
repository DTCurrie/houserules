#!/usr/bin/env node
/**
 * Scores every `<out>/<arm>/sample-<k>/` of the check-once fixture. Free: no network, no
 * session. Prints one table row and one `JSON {...}` line per sample.
 *
 *   node score.mjs <out-dir>
 *
 * The score is `callsBeforeFirstWrite`: the tool calls the session made before its first write
 * of any file. The entry under test says to read only what the ask names and write a first
 * version, so a lower count is the entry working. `totalCalls`, `wallS`, and `costUsd` show
 * whether the saving survives the later check, and `promptExists` is the floor: a sample with
 * no collected `prompt.md` did not do the task.
 *
 * A write is a Write, Edit, MultiEdit, or NotebookEdit call, or a Bash call that redirects
 * output to a file or pipes to `tee`. `valid` holds when the result event is a success and every
 * overlaid file still holds the overlay's bytes at exit. The fixture's validity agent is `none`,
 * because the task spawns no subagent, so the runner's own validity line does not apply here.
 *
 * Exit codes: 0 when every sample was scored, 2 on a usage error.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXIT_USAGE = 2;
const COST_DECIMAL_PLACES = 4;
const MS_PER_SECOND = 1000;
const WALL_DECIMAL_PLACES = 1;
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const BASH_REDIRECT_OR_TEE = /(?:^|[^0-9&>=<-])>{1,2}\s*[^\s;&|<>()&]|\btee\b/;
const HEREDOC_BODY = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g;

/** Every tool_use block of the stream's assistant events, in order. */
function toolUses(events) {
  return events
    .filter((event) => event?.type === 'assistant')
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block?.type === 'tool_use');
}

/** True when the tool call writes a file. */
function isWrite(use) {
  if (FILE_TOOLS.has(use.name)) return true;
  if (use.name !== 'Bash') return false;
  const command = String(use.input?.command ?? '');
  return BASH_REDIRECT_OR_TEE.test(
    command.replace(HEREDOC_BODY, (match) => match.split('\n')[0]),
  );
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function readStream(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** The ledger line for `arm` and `sample` under `out`, or null. */
function ledgerCost(out, arm, sample) {
  const ledger = join(out, 'spend.jsonl');
  if (!existsSync(ledger)) return null;
  for (const line of readFileSync(ledger, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const entry = JSON.parse(line);
    if (entry.arm === arm && entry.sample === sample) return entry.costUsd;
  }
  return null;
}

function round(value, places) {
  return value === null ? null : Number(value.toFixed(places));
}

function scoreSample(out, arm, dir, sample) {
  const events = readStream(join(dir, 'stream.jsonl'));
  const run = readJson(join(dir, 'run.json'));
  const result = events.filter((event) => event?.type === 'result').at(-1);
  const uses = toolUses(events);
  const firstWrite = uses.findIndex(isWrite);
  const overlays = run?.overlays ?? [];
  const isOverlayIntact =
    overlays.length > 0 &&
    overlays.every((overlay) => overlay.exitSha256 === overlay.overlaySha256);
  const cost =
    typeof result?.total_cost_usd === 'number'
      ? result.total_cost_usd
      : ledgerCost(out, arm, sample);
  return {
    arm,
    sample,
    valid: result?.subtype === 'success' && isOverlayIntact,
    callsBeforeFirstWrite: firstWrite === -1 ? null : firstWrite,
    totalCalls: uses.length,
    wallS:
      typeof result?.duration_ms === 'number'
        ? round(result.duration_ms / MS_PER_SECOND, WALL_DECIMAL_PLACES)
        : null,
    costUsd: round(cost, COST_DECIMAL_PLACES),
    promptExists: existsSync(join(dir, 'tree', 'prompt.md')),
  };
}

function sampleDirs(out) {
  const found = [];
  for (const arm of readdirSync(out, { withFileTypes: true })) {
    if (!arm.isDirectory()) continue;
    for (const entry of readdirSync(join(out, arm.name), {
      withFileTypes: true,
    })) {
      const match = /^sample-(\d+)$/.exec(entry.name);
      if (entry.isDirectory() && match)
        found.push([
          arm.name,
          join(out, arm.name, entry.name),
          Number(match[1]),
        ]);
    }
  }
  return found.sort(
    ([armA, , sampleA], [armB, , sampleB]) =>
      armA.localeCompare(armB) || sampleA - sampleB,
  );
}

const COLUMNS = [
  'arm',
  'sample',
  'valid',
  'callsBeforeFirstWrite',
  'totalCalls',
  'wallS',
  'costUsd',
  'promptExists',
];

function main(argv) {
  const out = argv[0];
  if (!out || !existsSync(out)) {
    console.error('usage: node score.mjs <out-dir>');
    return EXIT_USAGE;
  }
  console.log(COLUMNS.join('\t'));
  for (const [arm, dir, sample] of sampleDirs(out)) {
    const row = scoreSample(out, arm, dir, sample);
    console.log(COLUMNS.map((column) => String(row[column])).join('\t'));
    console.log(`JSON ${JSON.stringify(row)}`);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
