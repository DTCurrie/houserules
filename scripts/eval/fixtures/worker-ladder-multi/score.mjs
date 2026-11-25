#!/usr/bin/env node
/**
 * Scores every `<out>/<arm>/sample-<k>/` of the worker-ladder-multi fixture. Free: no network,
 * no session. Prints one table row and one `JSON {...}` line per sample.
 *
 *   node score.mjs <out-dir>
 *
 * Columns: `valid` is the runner's own validity judgment, `cost` the result event's
 * `total_cost_usd` (the ledger line when the stream has none), `hidden` the hidden tests run
 * against the fixture's own `repo/src` with only the collected `tree/src/invoice.js` copied in,
 * `visible` the fixture's visible tests against the same source, `accAfterEdit` whether a
 * task-worker Bash call ran a test command after the worker's last file write, `mainEdited`
 * whether the dispatcher itself wrote a file, and `outsideEdits` the `src/` files other than
 * `invoice.js` that differ from the fixture's. A run FAILS under the holds rule when `hidden`
 * fails or `accAfterEdit` is false.
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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeArmValidity } from '../../fixture-arm.mjs';
import { loadSample } from '../../orchestrate-report.mjs';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const HIDDEN_TESTS = join(FIXTURE_DIR, 'hidden', 'test');
const VISIBLE_TESTS = join(FIXTURE_DIR, 'repo', 'test');
const SEAM_SRC = join(FIXTURE_DIR, 'repo', 'src');
const OWNED_FILE = 'invoice.js';
const WORKER_TYPE = 'task-worker';
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TEST_COMMAND =
  /\bnode\s+(?:[^\n;&|]*\s)?--test\b|\bnpm\s+(?:run\s+)?test\b/;
const IN_PLACE_EDIT = /\b(?:sed|perl)\s+(?:-\S+\s+)*-i\b|\btee\s|\b(?:cp|mv)\s/;
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\2(?=\n|$)/g;
const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g;
const REDIRECT = /(?:^|[^0-9&>=<])>{1,2}\s*([^\s;&|<>()]+)/g;
const SKIPPED_TARGETS = /^(?:\/dev\/|&)/;
const TEST_RUN_TIMEOUT_MS = 60_000;
const EXIT_USAGE = 2;
const COST_DECIMAL_PLACES = 4;

/** Content blocks of one transcript or stream record. */
function blocks(record) {
  const content = record?.message?.content;
  return Array.isArray(content) ? content : [];
}

/** Every tool_use block of `records`, in order. */
function toolUses(records) {
  return records.flatMap((record) =>
    blocks(record).filter((block) => block?.type === 'tool_use'),
  );
}

/** Strips heredoc bodies and quoted strings, so an arrow function or a quoted `>` is no redirect. */
function shellSkeleton(command) {
  return command
    .replace(HEREDOC, (_match, _quote, _tag, rest) => ` <<HEREDOC${rest}`)
    .replace(QUOTED, "''");
}

/** A macOS temp path is reachable as `/var/...` and `/private/var/...`. Compare both as one. */
function unprivate(path) {
  return normalize(path).replace(/^\/private(?=\/)/, '');
}

/**
 * The offset in `command` where its last write into the sample starts, or -1. A redirect to an
 * absolute path outside `root` (a `/tmp` log) is not a write into the sample.
 */
function lastWriteOffset(command, root) {
  const skeleton = shellSkeleton(command);
  let offset = -1;
  for (const match of skeleton.matchAll(REDIRECT)) {
    const target = match[1];
    if (SKIPPED_TARGETS.test(target)) continue;
    if (
      isAbsolute(target) &&
      root &&
      !unprivate(target).startsWith(unprivate(root))
    )
      continue;
    offset = Math.max(offset, match.index);
  }
  const inPlace = [...skeleton.matchAll(new RegExp(IN_PLACE_EDIT, 'g'))].at(-1);
  if (inPlace) offset = Math.max(offset, inPlace.index);
  return offset;
}

/**
 * Walks one agent's tool calls and classifies each as a write, a visible-test run, or both.
 *
 * @returns {Array<{ isWrite: boolean, isTest: boolean, testAfterWrite: boolean }>}
 */
function classifyCalls(uses, root) {
  return uses.map((use) => {
    if (FILE_TOOLS.has(use.name))
      return { isWrite: true, isTest: false, testAfterWrite: false };
    if (use.name !== 'Bash')
      return { isWrite: false, isTest: false, testAfterWrite: false };
    const command = String(use.input?.command ?? '');
    const writeAt = lastWriteOffset(command, root);
    const testMatch = [
      ...shellSkeleton(command).matchAll(new RegExp(TEST_COMMAND, 'g')),
    ].at(-1);
    const isTest = testMatch !== undefined;
    return {
      isWrite: writeAt >= 0,
      isTest,
      testAfterWrite: isTest && testMatch.index > writeAt,
    };
  });
}

/**
 * True when the worker's last write is followed by a Bash call running the visible test. A
 * single Bash call that writes and then tests counts. A worker that never wrote is false.
 */
function acceptanceRanAfterLastEdit(calls) {
  const lastWrite = calls.findLastIndex((call) => call.isWrite);
  if (lastWrite < 0) return false;
  if (calls[lastWrite].testAfterWrite) return true;
  return calls.slice(lastWrite + 1).some((call) => call.isTest);
}

/** Names of the leaf tests that failed in TAP output `stdout`. */
export function parseFailingLeaves(stdout) {
  const lines = stdout.split('\n');
  const failing = [];
  lines.forEach((line, index) => {
    const header = /^\s*# Subtest: (.*)$/.exec(line);
    const result = /^\s*not ok \d+ - /.exec(lines[index + 1] ?? '');
    const isLeaf =
      header && /^\s*(?:not )?ok \d+ - /.test(lines[index + 1] ?? '');
    if (isLeaf && result) failing.push(header[1]);
  });
  return failing;
}

/**
 * Runs `node --test` over `testDir` against the fixture's `repo/src` with `ownedFile` copied in
 * as `src/invoice.js`, so an edit outside the owned path cannot change the score. Lists failing
 * leaf test names.
 */
function runTests(ownedFile, testDir) {
  const work = mkdtempSync(join(tmpdir(), 'worker-ladder-multi-score-'));
  try {
    cpSync(SEAM_SRC, join(work, 'src'), { recursive: true });
    cpSync(ownedFile, join(work, 'src', OWNED_FILE));
    cpSync(testDir, join(work, 'test'), { recursive: true });
    writeFileSync(join(work, 'package.json'), '{ "type": "module" }\n');
    const files = readdirSync(join(work, 'test'))
      .filter((name) => name.endsWith('.test.js'))
      .map((name) => join('test', name));
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', ...files],
      {
        cwd: work,
        env,
        encoding: 'utf8',
        timeout: TEST_RUN_TIMEOUT_MS,
      },
    );
    const failing = parseFailingLeaves(run.stdout);
    if (run.status !== 0 && failing.length === 0)
      failing.push(
        `(run exited ${run.status}: ${run.stderr.trim().split('\n').at(-1) ?? ''})`,
      );
    return { pass: run.status === 0, failing };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
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

/** True when the collected `tree/test` differs from the fixture's visible test. */
function testTreeDiffersFromVisible(treeTest) {
  if (!existsSync(treeTest)) return null;
  const names = readdirSync(VISIBLE_TESTS).sort();
  if (readdirSync(treeTest).sort().join('\n') !== names.join('\n')) return true;
  return names.some(
    (name) =>
      readFileSync(join(treeTest, name), 'utf8') !==
      readFileSync(join(VISIBLE_TESTS, name), 'utf8'),
  );
}

/** The collected `src/` files, other than the owned one, that were added, removed, or changed. */
function outsideEdits(treeSrc) {
  const seamNames = readdirSync(SEAM_SRC).filter((name) => name !== OWNED_FILE);
  const treeNames = readdirSync(treeSrc).filter((name) => name !== OWNED_FILE);
  const changed = seamNames.filter(
    (name) =>
      !treeNames.includes(name) ||
      readFileSync(join(treeSrc, name), 'utf8') !==
        readFileSync(join(SEAM_SRC, name), 'utf8'),
  );
  return [
    ...changed,
    ...treeNames.filter((name) => !seamNames.includes(name)),
  ].sort();
}

/** The result event's `total_cost_usd`, else the ledger line, else null. */
export function resolveCost(sample, out, arm, sampleNumber) {
  const result = sample.stream
    .filter((event) => event?.type === 'result')
    .at(-1);
  return typeof result?.total_cost_usd === 'number'
    ? result.total_cost_usd
    : ledgerCost(out, arm, sampleNumber);
}

/** Classifies the task-workers' calls and the dispatcher's own, and lists the dispatcher's Agent calls. */
function classifyAgentCalls(sample, root) {
  const workers = sample.subagents.filter(
    (agent) => agent.agentType === WORKER_TYPE,
  );
  const workerCalls = classifyCalls(
    toolUses(workers.flatMap((agent) => agent.records)),
    root,
  );
  const mainUses = toolUses(
    sample.stream.filter(
      (event) =>
        event?.type === 'assistant' && event.parent_tool_use_id == null,
    ),
  );
  const mainCalls = classifyCalls(mainUses, root);
  const dispatches = mainUses.filter(
    (use) => use.name === 'Agent' || use.name === 'Task',
  );
  return { workers, workerCalls, mainCalls, dispatches };
}

/** Runs the hidden and visible tests against the collected tree's owned file. */
function runTreeTests(treeSrc) {
  const ownedFile = join(treeSrc, OWNED_FILE);
  if (!existsSync(ownedFile)) {
    const missing = {
      pass: false,
      failing: [`(no tree/src/${OWNED_FILE} collected)`],
    };
    return { hidden: missing, visible: missing };
  }
  return {
    hidden: runTests(ownedFile, HIDDEN_TESTS),
    visible: runTests(ownedFile, VISIBLE_TESTS),
  };
}

function scoreSample(out, arm, dir) {
  const sampleNumber = Number(/^sample-(\d+)$/.exec(dir.split('/').at(-1))[1]);
  const sample = loadSample(dir);
  const validityAgent = sample.run?.validityAgent ?? WORKER_TYPE;
  const validity = judgeArmValidity(sample, validityAgent);
  const cost = resolveCost(sample, out, arm, sampleNumber);
  const { workers, workerCalls, mainCalls, dispatches } = classifyAgentCalls(
    sample,
    sample.run?.root ?? null,
  );

  const treeSrc = join(dir, 'tree', 'src');
  const { hidden, visible } = runTreeTests(treeSrc);
  const acceptanceAfterEdit = acceptanceRanAfterLastEdit(workerCalls);
  const isMainEdited = mainCalls.some((call) => call.isWrite);
  const isTestTreeChanged = testTreeDiffersFromVisible(
    join(dir, 'tree', 'test'),
  );

  return {
    arm,
    sample: sampleNumber,
    valid: validity.valid,
    validity: validity.line,
    cost,
    hidden: hidden.pass ? 'PASS' : 'FAIL',
    hiddenFailing: hidden.failing,
    visible: visible.pass ? 'PASS' : 'FAIL',
    acceptanceRanAfterLastEdit: acceptanceAfterEdit,
    mainEdited: isMainEdited,
    outsideEdits: existsSync(treeSrc) ? outsideEdits(treeSrc) : [],
    workerCount: workers.length,
    dispatchOverrides: dispatches.filter(
      (use) =>
        use.input?.model !== undefined || use.input?.effort !== undefined,
    ).length,
    testTreeChanged: isTestTreeChanged,
    holds: hidden.pass && acceptanceAfterEdit ? 'PASS' : 'FAIL',
  };
}

function sampleDirs(out) {
  const found = [];
  for (const arm of readdirSync(out, { withFileTypes: true })) {
    if (!arm.isDirectory()) continue;
    for (const entry of readdirSync(join(out, arm.name), {
      withFileTypes: true,
    })) {
      if (entry.isDirectory() && /^sample-\d+$/.test(entry.name))
        found.push([arm.name, join(out, arm.name, entry.name)]);
    }
  }
  return found.sort(([, left], [, right]) =>
    left.localeCompare(right, 'en', { numeric: true }),
  );
}

const IS_MAIN_MODULE =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
const out = process.argv[2];
if (IS_MAIN_MODULE && (!out || !existsSync(out))) {
  console.error('usage: node score.mjs <out-dir>');
  process.exit(EXIT_USAGE);
}

const COLUMNS = [
  'arm',
  'sample',
  'valid',
  'cost',
  'hidden',
  'visible',
  'accAfterEdit',
  'mainEdited',
  'outsideEdits',
  'holds',
];
if (IS_MAIN_MODULE) console.log(COLUMNS.join('\t'));
for (const [arm, dir] of IS_MAIN_MODULE ? sampleDirs(out) : []) {
  const row = scoreSample(out, arm, dir);
  const cost = row.cost === null ? '-' : row.cost.toFixed(COST_DECIMAL_PLACES);
  const outside =
    row.outsideEdits.length === 0 ? '-' : row.outsideEdits.join(',');
  console.log(
    [
      row.arm,
      row.sample,
      row.valid,
      cost,
      row.hidden,
      row.visible,
      row.acceptanceRanAfterLastEdit,
      row.mainEdited,
      outside,
      row.holds,
    ].join('\t'),
  );
  if (row.hiddenFailing.length > 0)
    console.log(
      `  hidden failing (${row.hiddenFailing.length}): ${row.hiddenFailing.join(' | ')}`,
    );
  console.log(`JSON ${JSON.stringify(row)}`);
}
