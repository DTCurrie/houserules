#!/usr/bin/env node
/**
 * Scores every `<out>/<arm>/sample-<k>/` of the flat-vs-nested fixture. Free: no network, no
 * session. Prints one table row and one `JSON {...}` line per sample, then one summary line per
 * arm over its valid samples.
 *
 *   node score.mjs <out-dir>
 *
 * Columns: `cost` is the result event's `total_cost_usd` (the ledger line when the stream has
 * none), `wallSeconds` the span of every stream and subagent timestamp, `maxGapSeconds` the
 * longest silence between two consecutive timestamps, `revises` the `SendMessage` calls to a
 * task-worker that came after its report reached the sender, `workers` and `orchestrators` the
 * spawns of each type across every transcript, `phasesDone` the collected ROADMAP's phases
 * reading `Status: DONE`, and `acceptance` PASS or FAIL from the fixture's own tests run against
 * the collected `tree/src`.
 *
 * A sample is valid when the runner did not void it, every phase reached DONE, the acceptance
 * passed, and no gap passed the limit. The first failing cause wins, in that order. A sample
 * that stopped at a ruling is invalid, never a cheap success.
 *
 * Exit codes: 0 when every sample was scored, 2 on a usage error.
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeArmValidity } from '../../fixture-arm.mjs';
import { loadSample, wallSeconds } from '../../orchestrate-report.mjs';
import {
  parseFailingLeaves,
  resolveCost,
} from '../worker-ladder-multi/score.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const PLAN_SLUG = 'eval-fixture';
const ROADMAP_PATH = join('.claude', 'plans', PLAN_SLUG, 'ROADMAP.md');
const WORKER_TYPE = 'task-worker';
const ORCHESTRATOR_TYPE = 'phase-orchestrator';
const MAX_GAP_SECONDS = 600;
const RULING_MARKER = 'NEEDS_RULING';
const PHASE_LINE = /^- \[.\] \*\*Phase \d+:.*$/gm;
const DONE_STATUS = /Status: DONE\b/;
const VOID_PREFIX = 'void, ';
const TEST_RUN_TIMEOUT_MS = 120_000;
const MS_PER_SECOND = 1000;
const EXIT_USAGE = 2;
const COST_DECIMAL_PLACES = 4;
const STAT_DECIMAL_PLACES = 2;
const SAMPLE_DIR_PATTERN = /^sample-(\d+)$/;

/** Content blocks of one transcript or stream record. */
function blocks(record) {
  const content = record?.message?.content;
  return Array.isArray(content) ? content : [];
}

/** The text a record carries: string content, text blocks, tool results, or a queued message. */
function recordText(record) {
  if (typeof record?.content === 'string') return record.content;
  const content = record?.message?.content;
  if (typeof content === 'string') return content;
  return blocks(record)
    .map((block) => {
      if (block?.type === 'text') return String(block.text ?? '');
      if (block?.type !== 'tool_result') return '';
      if (typeof block.content === 'string') return block.content;
      return Array.isArray(block.content)
        ? block.content.map((part) => String(part?.text ?? '')).join('\n')
        : '';
    })
    .join('\n');
}

/** Every transcript of a sample as an ordered record list: the stream, then each subagent. */
function transcripts(sample) {
  return [sample.stream, ...sample.subagents.map((agent) => agent.records)];
}

const isSpawn = (use) => use?.name === 'Agent' || use?.name === 'Task';

/** Spawn tool_use blocks of `subagentType` across every transcript, counted once per tool_use id. */
function countSpawns(sample, subagentType) {
  const ids = new Set();
  for (const records of transcripts(sample))
    for (const record of records)
      for (const block of blocks(record))
        if (
          block?.type === 'tool_use' &&
          isSpawn(block) &&
          block.input?.subagent_type === subagentType
        )
          ids.add(block.id ?? `${ids.size}`);
  return ids.size;
}

/**
 * Adds to `reported` each agent id whose report `text` carries: an `agent-message from="<id>"`
 * hand-back, or a `task-notification` whose `<task-id>` is the id and whose status is completed.
 */
function collectReports(text, reported) {
  for (const match of text.matchAll(/<agent-message from="([^"]+)"/g))
    reported.add(match[1]);
  for (const note of text.matchAll(
    /<task-notification>[\s\S]*?<\/task-notification>/g,
  )) {
    const taskId = /<task-id>\s*([^<\s]+)\s*<\/task-id>/.exec(note[0])?.[1];
    if (taskId && /<status>completed<\/status>/.test(note[0]))
      reported.add(taskId);
  }
}

/**
 * Records the agent id each worker spawn's tool_result names (`agentId: <id>`) into `workerIds`,
 * and maps the spawn's `name`, when it had one, to that id.
 */
function recordWorkerIds(record, spawns, workerIds, idByName) {
  for (const block of blocks(record)) {
    if (block?.type !== 'tool_result' || !spawns.has(block.tool_use_id))
      continue;
    const id = /agentId:\s*([\w-]+)/.exec(
      recordText({ message: { content: [block] } }),
    )?.[1];
    if (!id) continue;
    workerIds.add(id);
    const name = spawns.get(block.tool_use_id);
    if (name) idByName.set(name, id);
  }
}

/**
 * Counts the `SendMessage` calls in one transcript that go to a task-worker after that worker's
 * report reached the sender. A message to any other agent is never a revise.
 */
function reviseCount(records) {
  const spawns = new Map();
  const idByName = new Map();
  const workerIds = new Set();
  const reported = new Set();
  let revises = 0;
  for (const record of records) {
    if (record?.type === 'assistant') {
      for (const block of blocks(record)) {
        if (block?.type !== 'tool_use') continue;
        if (isSpawn(block) && block.input?.subagent_type === WORKER_TYPE)
          spawns.set(block.id, block.input?.name ?? null);
        if (block.name === 'SendMessage') {
          const target = String(block.input?.to ?? '');
          const id = idByName.get(target) ?? target;
          if (workerIds.has(id) && reported.has(id)) revises += 1;
        }
      }
      continue;
    }
    recordWorkerIds(record, spawns, workerIds, idByName);
    collectReports(recordText(record), reported);
  }
  return revises;
}

/** The longest gap in seconds between consecutive timestamps across stream and subagents. */
function maxGapSeconds(sample) {
  const times = transcripts(sample)
    .flat()
    .map((record) => Date.parse(record?.timestamp))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  let longest = 0;
  for (let index = 1; index < times.length; index += 1)
    longest = Math.max(longest, times[index] - times[index - 1]);
  return longest / MS_PER_SECOND;
}

/** Phase lines of a ROADMAP, and how many read `Status: DONE`. */
function phaseCounts(roadmapPath) {
  const lines = [...readFileSync(roadmapPath, 'utf8').matchAll(PHASE_LINE)];
  return {
    phaseCount: lines.length,
    phasesDone: lines.filter((line) => DONE_STATUS.test(line[0])).length,
  };
}

/**
 * Runs the fixture's own tests over a temp copy of `repo/` with the collected `tree/src` copied
 * over its `src`, so a test the session edited cannot change the score.
 */
function runAcceptance(treeSrc) {
  if (!existsSync(treeSrc))
    return { pass: false, failing: ['(no tree/src collected)'] };
  const work = mkdtempSync(join(tmpdir(), 'flat-vs-nested-score-'));
  try {
    cpSync(join(FIXTURE_DIR, 'repo'), work, { recursive: true });
    rmSync(join(work, 'src'), { recursive: true, force: true });
    cpSync(treeSrc, join(work, 'src'), { recursive: true });
    const files = readdirSync(join(work, 'test'))
      .filter((name) => name.endsWith('.test.js'))
      .map((name) => join('test', name));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', ...files],
      { cwd: work, env, encoding: 'utf8', timeout: TEST_RUN_TIMEOUT_MS },
    );
    const failing = parseFailingLeaves(run.stdout);
    if (run.status !== 0 && failing.length === 0)
      failing.push(`(run exited ${run.status})`);
    return { pass: run.status === 0, failing };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** True when the final result text or any assistant text names a ruling. */
function stoppedAtRuling(sample) {
  const results = sample.stream.filter((event) => event?.type === 'result');
  if (String(results.at(-1)?.result ?? '').includes(RULING_MARKER)) return true;
  return transcripts(sample)
    .flat()
    .some(
      (record) =>
        record?.type === 'assistant' &&
        recordText(record).includes(RULING_MARKER),
    );
}

/** The first failing validity cause in the documented order, or null when the sample is valid. */
function judgeCause(sample, row, voidLine, acceptance) {
  if (voidLine !== null) return voidLine;
  const allDone = row.phasesDone === row.phaseCount && row.phaseCount > 0;
  if (!allDone && stoppedAtRuling(sample)) return 'stopped at a ruling';
  if (!allDone) return `${row.phasesDone} of ${row.phaseCount} phases DONE`;
  if (!acceptance.pass)
    return `acceptance failed: ${acceptance.failing.join(' | ')}`;
  if (row.maxGapSeconds > MAX_GAP_SECONDS)
    return `gap ${row.maxGapSeconds}s over ${MAX_GAP_SECONDS}s, rerun`;
  return null;
}

function scoreSample(out, arm, dir) {
  const sampleNumber = Number(
    SAMPLE_DIR_PATTERN.exec(dir.split('/').at(-1))[1],
  );
  const sample = loadSample(dir);
  const validity = judgeArmValidity(sample, null);
  const roadmap = join(dir, 'tree', ROADMAP_PATH);
  const phases = phaseCounts(
    existsSync(roadmap) ? roadmap : join(FIXTURE_DIR, 'repo', ROADMAP_PATH),
  );
  const row = {
    arm,
    sample: sampleNumber,
    cost: resolveCost(sample, out, arm, sampleNumber),
    wallSeconds: wallSeconds(sample),
    maxGapSeconds: maxGapSeconds(sample),
    revises: transcripts(sample).reduce(
      (total, records) => total + reviseCount(records),
      0,
    ),
    workers: countSpawns(sample, WORKER_TYPE),
    orchestrators: countSpawns(sample, ORCHESTRATOR_TYPE),
    phasesDone: existsSync(roadmap) ? phases.phasesDone : 0,
    phaseCount: phases.phaseCount,
  };
  const acceptance = runAcceptance(join(dir, 'tree', 'src'));
  const voidLine = validity.valid
    ? null
    : (validity.line.split(VOID_PREFIX)[1] ?? validity.line);
  const cause = judgeCause(sample, row, voidLine, acceptance);
  return {
    ...row,
    valid: cause === null,
    cause,
    acceptance: acceptance.pass ? 'PASS' : 'FAIL',
  };
}

function sampleDirs(out) {
  const found = [];
  for (const arm of readdirSync(out, { withFileTypes: true })) {
    if (!arm.isDirectory()) continue;
    for (const entry of readdirSync(join(out, arm.name), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && SAMPLE_DIR_PATTERN.test(entry.name))
        found.push([arm.name, join(out, arm.name, entry.name)]);
    }
  }
  return found.sort(([, left], [, right]) =>
    left.localeCompare(right, 'en', { numeric: true }),
  );
}

/** `mean (min-max)` of the finite values of `values`, or `-` when there are none. */
function spread(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return '-';
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const digits = (value) => Number(value.toFixed(STAT_DECIMAL_PLACES));
  return `${digits(mean)} (${digits(Math.min(...finite))}-${digits(Math.max(...finite))})`;
}

/** One summary line per arm, over valid samples only. */
function summaryLines(rows) {
  const arms = [...new Set(rows.map((row) => row.arm))];
  return arms.map((arm) => {
    const armRows = rows.filter((row) => row.arm === arm);
    const valid = armRows.filter((row) => row.valid);
    return [
      `summary ${arm}`,
      `valid=${valid.length}`,
      `invalid=${armRows.length - valid.length}`,
      `cost=${spread(valid.map((row) => row.cost))}`,
      `wall=${spread(valid.map((row) => row.wallSeconds))}`,
      `revises=${spread(valid.map((row) => row.revises))}`,
    ].join('\t');
  });
}

const COLUMNS = [
  'arm',
  'sample',
  'valid',
  'cause',
  'cost',
  'wallSeconds',
  'maxGapSeconds',
  'revises',
  'workers',
  'orchestrators',
  'phasesDone',
  'acceptance',
];

function main(out) {
  console.log(COLUMNS.join('\t'));
  const rows = [];
  for (const [arm, dir] of sampleDirs(out)) {
    const row = scoreSample(out, arm, dir);
    rows.push(row);
    const cost =
      row.cost === null ? '-' : row.cost.toFixed(COST_DECIMAL_PLACES);
    console.log(
      [
        row.arm,
        row.sample,
        row.valid,
        row.cause ?? '-',
        cost,
        row.wallSeconds ?? '-',
        row.maxGapSeconds,
        row.revises,
        row.workers,
        row.orchestrators,
        `${row.phasesDone}/${row.phaseCount}`,
        row.acceptance,
      ].join('\t'),
    );
    console.log(`JSON ${JSON.stringify(row)}`);
  }
  for (const line of summaryLines(rows)) console.log(line);
}

const IS_MAIN_MODULE =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (IS_MAIN_MODULE) {
  const out = process.argv[2];
  if (!out || !existsSync(out)) {
    console.error('usage: node score.mjs <out-dir>');
    process.exit(EXIT_USAGE);
  }
  main(out);
}
