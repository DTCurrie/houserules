import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../health-kit/gather/plan-doc-writes.mjs', import.meta.url),
);

const LANDED = '2026-11-10T00:00:00Z';
const BEFORE_SESSION = '11111111-aaaa-4aaa-8aaa-111111111111';
const AFTER_SESSION = '22222222-bbbb-4bbb-8bbb-222222222222';
const SCAFFOLD_SESSION = '33333333-cccc-4ccc-8ccc-333333333333';
const REPO = '/Users/someone/Projects/repo';

let nextId = 0;
const toolUse = (timestamp, name, input) => {
  nextId += 1;
  return {
    id: `toolu_${nextId}`,
    record: {
      type: 'assistant',
      timestamp,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `toolu_${nextId}`, name, input }],
      },
    },
  };
};
const toolResult = (timestamp, id, text) => ({
  type: 'user',
  timestamp,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: text }],
  },
});

/** Builds the call records of one transcript, giving each call a result so the file reads like a session. */
function transcript(steps) {
  const records = [];
  steps.forEach(([timestamp, name, input, result], index) => {
    const call = toolUse(timestamp, name, input);
    records.push(call.record);
    records.push(toolResult(timestamp, call.id, result ?? `ok ${index}`));
  });
  return records;
}

function writeSession(root, session, mainSteps, subagentSteps = {}) {
  const jsonl = (records) =>
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  const mainPath = join(root, `${session}.jsonl`);
  writeFileSync(mainPath, jsonl(transcript(mainSteps)));
  const subagents = join(root, session, 'subagents');
  mkdirSync(subagents, { recursive: true });
  for (const [agent, steps] of Object.entries(subagentSteps)) {
    writeFileSync(
      join(subagents, `agent-${agent}.jsonl`),
      jsonl(transcript(steps)),
    );
  }
  return mainPath;
}

function run(args, root) {
  const out = join(root, 'plan-doc-writes.json');
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--landed', LANDED, ...args, '--json', out],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, json: JSON.parse(readFileSync(out, 'utf8')) };
}

const plan = (relative) => `${REPO}/.claude/plans/${relative}`;
const edit = (relative) => ({
  file_path: plan(relative),
  old_string: 'a',
  new_string: 'b',
});
const LINT_COMMAND = 'node .claude/scripts/plan-lint.mjs 2>&1';
const LINT_OUTPUT = [
  '.claude/plans/alpha/ROADMAP.md:3  ERROR  [plan-path/missing-file]  path does not exist',
  '.claude/plans/alpha/phase-1-x.md:9  WARN  [plan-path/stale]  stale',
  '.claude/plans/alpha/phase-1-x.md:12  WARN  [plan-path/stale]  stale',
  '3 findings',
].join('\n');

describe('plan-doc-writes', () => {
  it('counts edits after the first write per doc and lint findings per run, split by landing date', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-doc-writes-'));
    const before = writeSession(root, BEFORE_SESSION, [
      [
        '2026-11-01T10:00:00Z',
        'Write',
        { file_path: plan('alpha/ROADMAP.md'), content: 'x' },
      ],
      ['2026-11-01T10:01:00Z', 'Edit', edit('alpha/ROADMAP.md')],
      ['2026-11-01T10:02:00Z', 'Edit', edit('alpha/ROADMAP.md')],
      [
        '2026-11-01T10:03:00Z',
        'MultiEdit',
        { file_path: plan('alpha/ROADMAP.md'), edits: [{}, {}] },
      ],
      [
        '2026-11-01T10:04:00Z',
        'Bash',
        {
          command:
            'node .claude/scripts/plan-state.mjs set .claude/plans/alpha 1 DONE',
        },
      ],
      ['2026-11-01T10:05:00Z', 'Bash', { command: LINT_COMMAND }, LINT_OUTPUT],
      [
        '2026-11-01T10:06:00Z',
        'Write',
        { file_path: plan('alpha/phase-1-x.md'), content: 'x' },
      ],
      [
        '2026-11-01T10:07:00Z',
        'Bash',
        {
          command: "cat >> .claude/plans/alpha/phase-1-x.md <<'EOF'\nrow\nEOF",
        },
      ],
      [
        '2026-11-01T10:08:00Z',
        'Write',
        { file_path: `${REPO}/docs/ROADMAP.md`, content: 'x' },
      ],
      ['2026-11-01T10:09:00Z', 'Edit', edit('PLAN.md')],
      ['2026-11-01T10:10:00Z', 'Edit', edit('alpha/notes.md')],
      ['2026-11-01T10:11:00Z', 'Edit', edit('alpha/*/ROADMAP.md')],
      [
        '2026-11-01T10:12:00Z',
        'Bash',
        { command: 'grep plan-scaffold and plan-state set <workspace> x' },
      ],
    ]);
    const after = writeSession(
      root,
      AFTER_SESSION,
      [
        [
          '2026-11-12T10:00:00Z',
          'Write',
          { file_path: plan('beta/PLAN.md'), content: 'x' },
        ],
        [
          '2026-11-12T10:30:00Z',
          'Bash',
          { command: LINT_COMMAND },
          '0 findings',
        ],
        ['2026-11-12T11:00:00Z', 'Read', { file_path: plan('beta/PLAN.md') }],
        ['2026-11-12T11:01:00Z', 'Read', { file_path: plan('beta/PLAN.md') }],
        ['2026-11-12T11:02:00Z', 'Read', { file_path: plan('beta/PLAN.md') }],
        ['2026-11-12T11:03:00Z', 'Read', { file_path: plan('beta/PLAN.md') }],
        ['2026-11-12T11:04:00Z', 'Read', { file_path: plan('beta/PLAN.md') }],
        ['2026-11-12T11:05:00Z', 'Read', { file_path: plan('beta/PLAN.md') }],
        [
          '2026-11-12T11:06:00Z',
          'Bash',
          { command: LINT_COMMAND },
          LINT_OUTPUT,
        ],
      ],
      {
        a1b2c3: [['2026-11-12T10:10:00Z', 'Edit', edit('beta/PLAN.md')]],
      },
    );

    const { json, stdout } = run([before, after], root);

    assert.deepEqual(
      json.docs.map((doc) => [
        doc.doc,
        doc.side,
        doc.editsAfterScaffold,
        doc.bashWritesAfterScaffold,
      ]),
      [
        ['alpha/ROADMAP.md', 'before', 3, 1],
        ['alpha/phase-1-x.md', 'before', 0, 1],
        ['beta/PLAN.md', 'after', 1, 0],
      ],
    );
    assert.deepEqual(json.sides.before, {
      docs: 2,
      sessions: 1,
      docsEdited: 1,
      firstByBash: 0,
      editsMean: 1.5,
      editsMedian: 1.5,
      editsTotal: 3,
      bashWritesTotal: 2,
      lintRuns: 1,
      lintErrors: 1,
      lintWarns: 2,
      runsWithFindings: 1,
      findingsPerRun: 3,
    });
    assert.deepEqual(json.sides.after, {
      docs: 1,
      sessions: 1,
      docsEdited: 1,
      firstByBash: 0,
      editsMean: 1,
      editsMedian: 1,
      editsTotal: 1,
      bashWritesTotal: 0,
      lintRuns: 1,
      lintErrors: 0,
      lintWarns: 0,
      runsWithFindings: 0,
      findingsPerRun: 0,
    });
    assert.match(stdout, /^transcripts read: 2 main, 1 subagent$/m);
    assert.match(
      stdout,
      /^doc\s+side\s+first-write\s+sessions\s+edits-after\s+bash-after$/m,
    );
    assert.match(
      stdout,
      /^alpha\/ROADMAP\.md\s+before\s+2026-11-01T10:00:00\.000Z\s+1\s+3\s+1$/m,
    );
  });

  it('reads a plan-scaffold call as the first write, so the later fills count as edits', () => {
    const root = mkdtempSync(join(tmpdir(), 'plan-doc-writes-scaffold-'));
    const main = writeSession(root, SCAFFOLD_SESSION, [
      [
        '2026-11-15T09:00:00Z',
        'Bash',
        {
          command: 'node .claude/scripts/plan-scaffold.mjs gamma --phases a,b',
        },
      ],
      ['2026-11-15T09:01:00Z', 'Edit', edit('gamma/PLAN.md')],
      ['2026-11-15T09:02:00Z', 'Edit', edit('gamma/ROADMAP.md')],
      ['2026-11-15T09:03:00Z', 'Edit', edit('gamma/ROADMAP.md')],
    ]);

    const { json } = run([main], root);

    assert.deepEqual(
      json.docs.map((doc) => [doc.doc, doc.side, doc.editsAfterScaffold]),
      [
        ['gamma/PLAN.md', 'after', 1],
        ['gamma/ROADMAP.md', 'after', 2],
      ],
    );
    assert.equal(json.sides.after.editsMedian, 1.5);
    assert.equal(json.sides.after.firstByBash, 2);
    assert.equal(json.sides.before.editsMedian, null);
  });

  it('exits 2 with a usage line when --landed is missing', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'x.jsonl'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^usage: node plan-doc-writes\.mjs/m);
  });

  it('exits 2 with a usage line when no transcript is given', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '--landed', LANDED], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no main transcript given/);
  });
});
