import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const FIXTURE = join(REPO_ROOT, 'scripts', 'eval', 'fixtures', 'ledger-batch');
const CLAUSE =
  ' When one turn adds several entries, spawn one reviewer after the last add and pass it every new id.';
const OVERLAY_FILES = ['skills/backlog-add/SKILL.md', 'skills/decide/SKILL.md'];
const temps = [];

const read = (...parts) => readFileSync(join(FIXTURE, ...parts), 'utf8');

function agentCall(id, type) {
  return {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id, name: 'Agent', input: { subagent_type: type } },
      ],
    },
  };
}

function syntheticRun() {
  const out = mkdtempSync(join(tmpdir(), 'hr-ledger-batch-'));
  temps.push(out);
  const sample = join(out, 'batch', 'sample-1');
  const ledgers = join(sample, 'tree', '.claude', 'ledgers');
  mkdirSync(ledgers, { recursive: true });
  writeFileSync(join(sample, 'run.json'), '{}\n');
  const records = [
    agentCall('toolu_1', 'backlog-reviewer'),
    agentCall('toolu_1', 'backlog-reviewer'),
    agentCall('toolu_2', 'decision-reviewer'),
    agentCall('toolu_3', 'Explore'),
    {
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.1234,
      duration_ms: 12500,
    },
  ];
  writeFileSync(
    join(sample, 'stream.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
  writeFileSync(
    join(ledgers, 'backlog.jsonl'),
    '{"id":"a"}\n{"id":"b"}\n{"id":"c"}\n',
  );
  writeFileSync(join(ledgers, 'decisions.jsonl'), '{"id":"d"}\n\n');
  return out;
}

describe('ledger-batch fixture', () => {
  after(() => {
    for (const root of temps) rmSync(root, { recursive: true, force: true });
  });

  it('parses eval.json with the per-entry and batch arms and no network', () => {
    const spec = JSON.parse(read('eval.json'));

    assert.deepEqual(Object.keys(spec.arms).sort(), ['batch', 'per-entry']);
    assert.equal(spec.network, false);
    assert.equal(spec.validityAgent, 'backlog-reviewer');
    assert.deepEqual(spec.modules, 'backlog/backlog,decisions/decisions');
  });

  it('keeps the batch overlays at the shipped skill text', () => {
    const shipped = {
      'skills/backlog-add/SKILL.md': readFileSync(
        join(
          REPO_ROOT,
          'packages',
          'plugin-backlog',
          'payload',
          'skills',
          'backlog-add',
          'SKILL.md',
        ),
        'utf8',
      ),
      'skills/decide/SKILL.md': readFileSync(
        join(
          REPO_ROOT,
          'packages',
          'plugin-decisions',
          'payload',
          'skills',
          'decide',
          'SKILL.md',
        ),
        'utf8',
      ),
    };

    const drifted = OVERLAY_FILES.filter(
      (file) => read('arms', 'batch', 'overlay', file) !== shipped[file],
    );

    assert.deepEqual(drifted, []);
  });

  it('differs between the arms only by the one-reviewer clause', () => {
    const unequal = OVERLAY_FILES.filter(
      (file) =>
        read('arms', 'batch', 'overlay', file).replace(CLAUSE, '') !==
        read('arms', 'per-entry', 'overlay', file),
    );
    const clauseCounts = OVERLAY_FILES.map((file) => [
      read('arms', 'batch', 'overlay', file).split(CLAUSE).length - 1,
      read('arms', 'per-entry', 'overlay', file).split(CLAUSE).length - 1,
    ]);

    assert.deepEqual(unequal, []);
    assert.deepEqual(clauseCounts, [
      [1, 0],
      [1, 0],
    ]);
  });

  it('gives both arms the same prompt naming three backlog entries and one decision', () => {
    const batch = read('arms', 'batch', 'prompt.txt');

    assert.equal(read('arms', 'per-entry', 'prompt.txt'), batch);
    assert.equal(batch.match(/^\d\. `src\//gm).length, 3);
    assert.ok(batch.includes('with the decide skill'), batch);
  });

  it('scores a synthetic run dir as one row', () => {
    const result = spawnSync(
      process.execPath,
      [join(FIXTURE, 'score.mjs'), syntheticRun()],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout.split('\n')[0],
      'batch sample-1  reviewers=2 (backlog 1, decision 1)  rows=4  cost=$0.1234  wall=12.5s',
    );
  });

  it('exits 2 with no run dir', () => {
    const result = spawnSync(process.execPath, [join(FIXTURE, 'score.mjs')], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 2);
  });
});
