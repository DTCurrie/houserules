#!/usr/bin/env node
/**
 * Scores every `<out>/<arm>/sample-<k>/` of the manual-mode fixture, or one sample directory
 * given directly. Free: no network, no session. Prints one line and one `JSON {...}` line per
 * sample, then one `ARM {...}` line per arm with its pass count.
 *
 *   node score.mjs <out-dir | sample-dir>
 *
 * A sample passes when an `AskUserQuestion` tool call comes before the first `Agent` (or `Task`)
 * tool call of the dispatcher's stream. A session that makes neither call fails, because it
 * never asked and never dispatched.
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

/**
 * Scores one stream.
 *
 * @param {object[]} events Parsed stream-json events.
 * @returns {{ isPass: boolean, askIndex: number | null, agentIndex: number | null }}
 */
export function scoreStream(events) {
  const uses = toolUses(events);
  const askIndex = uses.findIndex((use) => use.name === ASK_TOOL);
  const agentIndex = uses.findIndex((use) => DISPATCH_TOOLS.has(use.name));
  return {
    isPass: askIndex !== -1 && (agentIndex === -1 || askIndex < agentIndex),
    askIndex: askIndex === -1 ? null : askIndex,
    agentIndex: agentIndex === -1 ? null : agentIndex,
  };
}

/** Prints one sample's summary line and its `JSON {...}` line. */
function printSampleScore(score) {
  process.stdout.write(
    `${score.sample} arm=${score.arm} pass=${score.isPass} ask=${score.askIndex} agent=${score.agentIndex}\n`,
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
    const score = {
      arm,
      sample: basename(dir),
      ...scoreStream(readStream(join(dir, 'stream.jsonl'))),
    };
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
