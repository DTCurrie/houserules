#!/usr/bin/env node
/**
 * Scores every `<out>/<arm>/sample-<k>/` of the keepalive-once fixture, or one sample directory
 * given directly. Free: no network, no session. Prints one line and one `JSON {...}` line per
 * sample.
 *
 *   node score.mjs <out-dir | sample-dir>
 *
 * Reads the phase-orchestrator's subagent transcript. `launches` counts its Bash calls with
 * `run_in_background: true`. `perWave` splits them: wave 0 holds launches before the first
 * task-worker dispatch, and a task-worker dispatch opens a new wave when a launch happened since
 * the previous dispatch, so dispatches with no launch between them share a wave. `overlaps`
 * counts launches made while an earlier launch was still running. A launch ends at the first
 * later record that names its background task id beside a finished status (`completed`,
 * `failed`, `killed`, or `exited`), and a launch with no such record runs to the end of the
 * transcript. `cost` is the result event's `total_cost_usd`, and `wallS` the result event's
 * `duration_ms` in seconds, each null when the stream has none.
 *
 * Exit codes: 0 when every sample was scored, 2 on a usage error.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSample } from '../../orchestrate-report.mjs';

const EXIT_USAGE = 2;
const PHASE_ORCHESTRATOR = 'phase-orchestrator';
const WORKER_TYPE = 'task-worker';
const DISPATCH_TOOLS = new Set(['Agent', 'Task']);
const TASK_ID = /Command running in background with ID: (\S+?)\./;
const FINISHED = /completed|failed|killed|exited/;
const MS_PER_SECOND = 1000;
const COST_DECIMAL_PLACES = 4;
const WALL_DECIMAL_PLACES = 1;

const CONVERSATION_TYPES = new Set(['assistant', 'user']);

/**
 * Content blocks of one conversation record. Other record types, such as `api-request-blob`,
 * echo earlier requests and would count a launch twice.
 */
function blocks(record) {
  if (!CONVERSATION_TYPES.has(record?.type)) return [];
  const content = record?.message?.content;
  return Array.isArray(content) ? content : [];
}

/** The text of a tool_result block's content, whatever its shape. */
function resultText(block) {
  const { content } = block;
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map((part) => part?.text ?? '').join('\n');
  return '';
}

/**
 * Walks the transcript once. Returns the background launches in order, each as
 * `{ wave, index, taskId, endIndex }` where `index` is the record number of the launch and
 * `endIndex` the record number that ended it, or the record count when none did.
 *
 * @param {object[]} records
 */
function backgroundLaunches(records) {
  const launches = [];
  const byToolUse = new Map();
  let wave = 0;
  let dispatched = false;
  let launchedSinceDispatch = false;
  records.forEach((record, index) => {
    for (const block of blocks(record)) {
      if (block?.type === 'tool_use') {
        if (
          DISPATCH_TOOLS.has(block.name) &&
          block.input?.subagent_type === WORKER_TYPE
        ) {
          if (!dispatched) wave = 1;
          else if (launchedSinceDispatch) wave += 1;
          dispatched = true;
          launchedSinceDispatch = false;
        }
        if (block.name === 'Bash' && block.input?.run_in_background === true) {
          const launch = {
            wave,
            index,
            taskId: null,
            endIndex: records.length,
          };
          launches.push(launch);
          byToolUse.set(block.id, launch);
          launchedSinceDispatch = true;
        }
      } else if (block?.type === 'tool_result') {
        const launch = byToolUse.get(block.tool_use_id);
        const match = launch ? TASK_ID.exec(resultText(block)) : null;
        if (launch && match) launch.taskId = match[1];
      }
    }
  });
  markLaunchEnds(records, launches);
  return launches;
}

/** Sets each launch's `endIndex` to the first later record naming its task id beside a finished status. */
function markLaunchEnds(records, launches) {
  for (const launch of launches) {
    if (!launch.taskId) continue;
    for (let i = launch.index + 1; i < records.length; i += 1) {
      const text = JSON.stringify(records[i]);
      if (text.includes(launch.taskId) && FINISHED.test(text)) {
        launch.endIndex = i;
        break;
      }
    }
  }
}

/** Launches made while an earlier launch had not yet ended. */
function countOverlaps(launches) {
  return launches.filter((launch) =>
    launches.some(
      (earlier) =>
        earlier.index < launch.index && earlier.endIndex > launch.index,
    ),
  ).length;
}

/** The last `result` event of the dispatcher's stream, or null. */
function resultEvent(stream) {
  return stream.filter((event) => event?.type === 'result').at(-1) ?? null;
}

/** One sample's score from a loaded sample. */
function scoreSample(sample) {
  const orchestrators = sample.subagents.filter(
    (agent) => agent.agentType === PHASE_ORCHESTRATOR,
  );
  const launchesByOrchestrator = orchestrators.map((agent) =>
    backgroundLaunches(agent.records),
  );
  const launches = launchesByOrchestrator.flat();
  const perWave = [];
  for (const launch of launches)
    perWave[launch.wave] = (perWave[launch.wave] ?? 0) + 1;
  const result = resultEvent(sample.stream);
  const cost = result?.total_cost_usd;
  const wall = result?.duration_ms;
  return {
    sample: sample.label,
    arm: sample.run?.arm ?? null,
    orchestrators: orchestrators.length,
    launches: launches.length,
    perWave: Array.from(perWave, (count) => count ?? 0),
    overlaps: launchesByOrchestrator.reduce(
      (total, own) => total + countOverlaps(own),
      0,
    ),
    cost:
      typeof cost === 'number'
        ? Number(cost.toFixed(COST_DECIMAL_PLACES))
        : null,
    wallS:
      typeof wall === 'number'
        ? Number((wall / MS_PER_SECOND).toFixed(WALL_DECIMAL_PLACES))
        : null,
  };
}

/** Sample directories under `target`: itself when it holds `run.json`, else `<arm>/sample-*`. */
function sampleDirs(target) {
  if (existsSync(join(target, 'run.json'))) return [target];
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
  for (const dir of sampleDirs(target)) {
    const score = scoreSample(loadSample(dir));
    process.stdout.write(
      `${score.sample} arm=${score.arm} launches=${score.launches} perWave=[${score.perWave}] overlaps=${score.overlaps} cost=${score.cost} wallS=${score.wallS}\n`,
    );
    process.stdout.write(`JSON ${JSON.stringify(score)}\n`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
