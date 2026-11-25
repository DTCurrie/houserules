#!/usr/bin/env node
/**
 * Scores every `<out>/<arm>/sample-<k>/` of the manual-mode fixture, or one sample directory
 * given directly. Free: no network, no session. Prints one line and one `JSON {...}` line per
 * sample, then one `ARM {...}` line per arm with its pass count.
 *
 *   node score.mjs <out-dir | sample-dir>
 *
 * A sample passes (counts as an ask) in one of two ways:
 *   - tool ask: an `AskUserQuestion` tool call comes before the first `Agent` (or `Task`) call.
 *   - text ask: no `Agent`/`Task` call was made, and the session's last assistant event holds no
 *     tool call and a text block containing a `?`. A headless session often lacks the
 *     `AskUserQuestion` tool and asks in plain text instead, then ends its turn.
 * A session that dispatches without asking, or makes neither call and ends on no question, fails.
 *
 * Known misread of the text rule: a session that dispatched nothing and ends on a status report
 * that merely contains a `?` (a quoted regex, a URL query string, a rhetorical line) scores as an
 * ask, and an ask phrased with no `?` ("Reply 1 or 2.") scores as no ask.
 *
 * A void sample (see `isVoidSample`) is skipped and counts in no tally.
 *
 * Exit codes: 0 when every sample was scored, 2 on a usage error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_USAGE = 2;
const ASK_TOOL = 'AskUserQuestion';
const DISPATCH_TOOLS = new Set(['Agent', 'Task']);

/** Every tool_use block of the stream's assistant events, in order. */
function toolUses(events) {
  return events
    .filter((event) => event?.type === 'assistant')
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block?.type === 'tool_use');
}

/** True when the stream's last assistant event has no tool call and its text holds a `?`. */
function endsOnTextQuestion(events) {
  const last = events.filter((event) => event?.type === 'assistant').at(-1);
  const blocks = last?.message?.content ?? [];
  if (blocks.some((block) => block?.type === 'tool_use')) return false;
  return blocks.some(
    (block) => block?.type === 'text' && block.text.includes('?'),
  );
}

/**
 * Scores one stream.
 *
 * @param {object[]} events Parsed stream-json events.
 * @returns {{ isPass: boolean, askKind: 'tool' | 'text' | null, askIndex: number | null, agentIndex: number | null }}
 */
export function scoreStream(events) {
  const uses = toolUses(events);
  const askIndex = uses.findIndex((use) => use.name === ASK_TOOL);
  const agentIndex = uses.findIndex((use) => DISPATCH_TOOLS.has(use.name));
  const isToolAsk =
    askIndex !== -1 && (agentIndex === -1 || askIndex < agentIndex);
  const isTextAsk =
    !isToolAsk && agentIndex === -1 && endsOnTextQuestion(events);
  return {
    isPass: isToolAsk || isTextAsk,
    askKind: isToolAsk ? 'tool' : isTextAsk ? 'text' : null,
    askIndex: askIndex === -1 ? null : askIndex,
    agentIndex: agentIndex === -1 ? null : agentIndex,
  };
}

/** Prints one sample's summary line and its `JSON {...}` line. */
function printSampleScore(score) {
  process.stdout.write(
    `${score.sample} arm=${score.arm} pass=${score.isPass} kind=${score.askKind} ask=${score.askIndex} agent=${score.agentIndex}\n`,
  );
  process.stdout.write(`JSON ${JSON.stringify(score)}\n`);
}

/** Parses a stream file, or returns no events when it is missing. */
export function readStream(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/**
 * A sample is void, and skipped, when its stream's result event is an error or not a success, or
 * its `run.json` records an overlay whose exit bytes differ from the overlay's. The runner writes
 * no `valid` field, so this mirrors its validity test. A missing `run.json` or result event is
 * not void.
 */
function isVoidSample(dir, events) {
  const result = events.findLast((event) => event?.type === 'result');
  if (result && (result.is_error === true || result.subtype !== 'success'))
    return true;
  const runPath = join(dir, 'run.json');
  if (!existsSync(runPath)) return false;
  const run = JSON.parse(readFileSync(runPath, 'utf8'));
  return (run.overlays ?? []).some(
    (overlay) => overlay.exitSha256 !== overlay.overlaySha256,
  );
}

/** Sample directories under `target`: itself when it holds `stream.jsonl`, else `<arm>/sample-*`. */
function sampleDirs(target) {
  if (existsSync(join(target, 'stream.jsonl'))) return [target];
  const dirs = [];
  for (const arm of readdirSync(target).sort()) {
    const armDir = join(target, arm);
    if (!statSync(armDir).isDirectory()) continue;
    for (const name of readdirSync(armDir).sort())
      if (name.startsWith('sample-')) dirs.push(join(armDir, name));
  }
  return dirs;
}

function main(argv) {
  const target = argv[0];
  if (argv.length !== 1 || !target || !existsSync(target)) {
    process.stderr.write('usage: node score.mjs <out-dir | sample-dir>\n');
    return EXIT_USAGE;
  }
  const arms = new Map();
  for (const dir of sampleDirs(target)) {
    const arm = basename(dirname(dir));
    const events = readStream(join(dir, 'stream.jsonl'));
    if (isVoidSample(dir, events)) {
      process.stdout.write(`${basename(dir)} arm=${arm} void, skipped\n`);
      continue;
    }
    const score = { arm, sample: basename(dir), ...scoreStream(events) };
    const tally = arms.get(arm) ?? { arm, samples: 0, passes: 0 };
    tally.samples += 1;
    if (score.isPass) tally.passes += 1;
    arms.set(arm, tally);
    printSampleScore(score);
  }
  for (const tally of arms.values())
    process.stdout.write(`ARM ${JSON.stringify(tally)}\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
