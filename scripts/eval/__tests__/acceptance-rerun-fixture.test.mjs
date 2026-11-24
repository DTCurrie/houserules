import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classify } from '../../health-kit/gather/waste-audit.mjs';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'acceptance-rerun',
);
const TEST_FILES = [
  'cartons',
  'depots',
  'duties',
  'fuel',
  'hazards',
  'rates',
  'tiers',
  'volume',
  'zones',
].map((name) => `test/${name}.test.mjs`);
const COMMAND = `node --test --test-reporter=./test/summary-reporter.mjs ${TEST_FILES.join(' ')}`;
const FAILING_TEST = 'fuel surcharge on a September consignment';
const MIN_MODULES = 8;
const TAIL_LINES = 30;
const ARMS = ['control', 'file-clause', 'names-report'];
const FILE_CLAUSE_LINE =
  "Run the acceptance with its full output saved to a file, report the tail of that file, and read a failing test's name from the file instead of running the command again.";
const CONTROL_REPORT_LINES = [
  'red, run it again, and stop the moment it goes green. Include the last ~10 lines of each in your',
  'report.',
];
const NAMES_REPORT_LINES = [
  'red, run it again, and stop the moment it goes green. Report the last ~10 lines of each passing',
  'run, or name each failing test and its error.',
];
const OVERLAY_SHA256_AT_5FA1E34 = {
  control: 'e427c20c757accbfb4340d1f3c56819bbc8dd4681997c219bbb67f1338f55732',
  'file-clause':
    'ac0d7e00377230028fbbc305a4bd6a7d0ff7c635ea52f0f5c1b82bb648f8072b',
  'names-report':
    '4e55c5ef416d78a120c35d555ebce7be0f6b0c7b99d1e3c045d201bcac6a66f6',
};
const temps = [];

function envOutsideParentRun() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function sampleRoot(withSolution) {
  const root = mkdtempSync(join(tmpdir(), 'hr-acceptance-rerun-'));
  temps.push(root);
  cpSync(join(FIXTURE, 'repo'), root, { recursive: true });
  if (withSolution)
    cpSync(join(FIXTURE, 'solution'), root, { recursive: true });
  return root;
}

function runAcceptance(root) {
  const result = spawnSync('sh', ['-c', `${COMMAND} 2>&1`], {
    cwd: root,
    env: envOutsideParentRun(),
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout };
}

function testNames() {
  const names = [];
  for (const file of TEST_FILES) {
    const source = readFileSync(join(FIXTURE, 'repo', file), 'utf8');
    for (const match of source.matchAll(/^test\('([^']+)'/gm))
      names.push(match[1]);
  }
  return names;
}

const lastLines = (output, count) =>
  output.trimEnd().split('\n').slice(-count).join('\n');

function workerTranscript(calls) {
  const records = [];
  calls.forEach(({ command, result }, index) => {
    const id = `toolu_${index + 1}`;
    records.push({
      type: 'assistant',
      message: {
        id: `msg_${index + 1}`,
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
      },
    });
    records.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: result }],
      },
    });
  });
  return records.map((record) => JSON.stringify(record)).join('\n');
}

function rerunCalls(text) {
  const found = classify(text, '/x/subagents/agent-a1.jsonl', 'task-worker');
  return found.kinds['acceptance-rerun-after-report'].reduce(
    (total, episode) => total + episode.calls,
    0,
  );
}

const readPromptLines = (arm) =>
  readFileSync(join(FIXTURE, 'arms', arm, 'prompt.txt'), 'utf8').split('\n');

describe('acceptance-rerun fixture', () => {
  after(() => {
    for (const root of temps) rmSync(root, { recursive: true, force: true });
  });

  it('spreads the repo over enough modules, each with its own test file', () => {
    const modules = readdirSync(join(FIXTURE, 'repo', 'src')).sort();
    assert.ok(modules.length >= MIN_MODULES);
    assert.deepEqual(
      modules.map((name) => `test/${name.replace(/\.mjs$/, '.test.mjs')}`),
      TEST_FILES,
    );
    const testDir = readdirSync(join(FIXTURE, 'repo', 'test'));
    assert.deepEqual(
      testDir.filter((name) => name.endsWith('.test.mjs')).sort(),
      TEST_FILES.map((file) => file.slice('test/'.length)),
    );
    assert.deepEqual(readdirSync(join(FIXTURE, 'solution')), ['src']);
    assert.deepEqual(readdirSync(join(FIXTURE, 'solution', 'src')), [
      'fuel.mjs',
    ]);
  });

  it('fails on the repo and names the failing test only above the summary tail', () => {
    const { status, output } = runAcceptance(sampleRoot(false));
    assert.notEqual(status, 0);
    assert.ok(output.includes(FAILING_TEST), output);
    const lines = output.trimEnd().split('\n');
    assert.ok(lines.length > TAIL_LINES);
    assert.equal(lines.at(-1), '1 failed');
    const tail = lastLines(output, TAIL_LINES);
    const names = testNames();
    assert.ok(names.includes(FAILING_TEST));
    for (const name of names) assert.ok(!tail.includes(name), name);
    assert.ok(!tail.includes('src/'));
    assert.ok(!tail.includes('✖'));
    assert.ok(!/assert|Error|\bat /.test(tail), tail);
  });

  it('passes with the solution overlaid', () => {
    const { status, output } = runAcceptance(sampleRoot(true));
    assert.equal(status, 0, output);
    assert.equal(lastLines(output, 1), '0 failed');
  });

  it('counts one rerun after a failing run piped to tail -10', () => {
    const { output } = runAcceptance(sampleRoot(false));
    const text = workerTranscript([
      {
        command: `${COMMAND} 2>&1 | tail -10`,
        result: lastLines(output, 10),
      },
      {
        command: `${COMMAND} 2>&1 | head -5`,
        result: output.split('\n').slice(0, 5).join('\n'),
      },
    ]);
    assert.equal(rerunCalls(text), 1);
  });

  it('counts no rerun when the first run held the whole output', () => {
    const { output } = runAcceptance(sampleRoot(false));
    const text = workerTranscript([
      { command: `${COMMAND} 2>&1`, result: output },
      {
        command: `${COMMAND} 2>&1 | head -5`,
        result: output.split('\n').slice(0, 5).join('\n'),
      },
    ]);
    assert.equal(rerunCalls(text), 0);
  });

  it('gives every arm the acceptance command and no single module as context', () => {
    for (const arm of ARMS) {
      const prompt = readPromptLines(arm).join('\n');
      assert.equal(prompt.split(`\`${COMMAND}\``).length - 1, 2, arm);
      assert.ok(prompt.includes('these paths: `src/`.'), arm);
      assert.ok(
        prompt.includes(
          'Context you need: the `src/` and `test/` directories.',
        ),
        arm,
      );
      assert.ok(!/src\/[a-z]+\.mjs/.test(prompt), arm);
    }
  });

  it('keeps the arm prompts equal except for the text under test', () => {
    const control = readPromptLines('control');
    const fileClause = readPromptLines('file-clause');
    const at = fileClause.indexOf(FILE_CLAUSE_LINE);
    assert.ok(at > 0);
    assert.deepEqual(fileClause.toSpliced(at, 1), control);
    const reportAt = control.indexOf(CONTROL_REPORT_LINES[0]);
    assert.deepEqual(
      control.slice(reportAt, reportAt + 2),
      CONTROL_REPORT_LINES,
    );
    assert.deepEqual(
      readPromptLines('names-report'),
      control.toSpliced(reportAt, 2, ...NAMES_REPORT_LINES),
    );
  });

  it('keeps each overlay at the bytes it was built with', () => {
    for (const arm of ARMS) {
      const bytes = readFileSync(
        join(FIXTURE, 'arms', arm, 'overlay', 'agents', 'task-worker.md'),
      );
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        OVERLAY_SHA256_AT_5FA1E34[arm],
        `${arm} overlay drifted from its rev 5fa1e34 build`,
      );
    }
  });
});
