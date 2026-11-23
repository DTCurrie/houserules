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
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildTable } from '../actions-report.mjs';

const SCRIPT = fileURLToPath(new URL('../actions-report.mjs', import.meta.url));
const temps = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'actions-report-'));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('actions-report table', () => {
  test('sorts by arm then sample and renders every cell form', () => {
    const records = [
      {
        arm: 'opus',
        sample: 2,
        valid: false,
        costUsd: null,
        wallSeconds: 61.25,
        runnerImage: 'ubuntu-24.04',
      },
      {
        arm: 'haiku',
        sample: 1,
        valid: null,
        costUsd: null,
        wallSeconds: 3,
        runnerImage: 'ubuntu-24.04',
      },
      {
        arm: 'opus',
        sample: 1,
        valid: true,
        costUsd: 1.234,
        wallSeconds: 120.04,
        runnerImage: 'ubuntu-24.04-arm',
      },
      {
        arm: 'haiku',
        sample: 10,
        valid: true,
        costUsd: 0.5,
        wallSeconds: 7.96,
        runnerImage: 'ubuntu-24.04',
      },
    ];
    assert.equal(
      buildTable(records),
      [
        '| arm | sample | valid | cost | wall s | runner image |',
        '| --- | --- | --- | --- | --- | --- |',
        '| haiku | 1 | dry run | n/a | 3.0 | ubuntu-24.04 |',
        '| haiku | 10 | yes | $0.50 | 8.0 | ubuntu-24.04 |',
        '| opus | 1 | yes | $1.23 | 120.0 | ubuntu-24.04-arm |',
        '| opus | 2 | no | n/a | 61.3 | ubuntu-24.04 |',
        '',
        'A wall-time gap under 10% across runners reads as a tie.',
        '',
      ].join('\n'),
    );
  });

  test('reads records nested in their own folders', () => {
    const dir = tempDir();
    mkdirSync(join(dir, 'a', 'deep'), { recursive: true });
    writeFileSync(
      join(dir, 'a', 'deep', 'r.json'),
      JSON.stringify({
        arm: 'x',
        sample: 1,
        valid: null,
        costUsd: null,
        wallSeconds: 1,
        runnerImage: 'img',
      }),
    );
    assert.match(
      run(['table', dir]).stdout,
      /\| x \| 1 \| dry run \| n\/a \| 1\.0 \| img \|/,
    );
  });
});

describe('actions-report record', () => {
  test('paid record reads validity and cost from the sample directory', () => {
    const out = tempDir();
    const sampleDir = join(out, 'armA', 'sample-1');
    mkdirSync(sampleDir, { recursive: true });
    writeFileSync(
      join(sampleDir, 'run.json'),
      JSON.stringify({
        validityAgent: 'worker',
        overlays: [
          {
            path: 'a.md',
            initSha256: 'i',
            overlaySha256: 'o',
            exitSha256: 'o',
          },
        ],
      }),
    );
    writeFileSync(
      join(sampleDir, 'stream.jsonl'),
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 2.5,
        subagent_stats: { by_type: { worker: 1 } },
      })}\n`,
    );
    const file = join(out, 'rec', 'record.json');
    const result = run([
      'record',
      '--out',
      out,
      '--arm',
      'armA',
      '--sample',
      '1',
      '--mode',
      'paid',
      '--exit',
      '0',
      '--wall',
      '42.5',
      '--image',
      'ubuntu-24.04',
      '--file',
      file,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      arm: 'armA',
      sample: 1,
      mode: 'paid',
      exitCode: 0,
      valid: true,
      costUsd: 2.5,
      wallSeconds: 42.5,
      runnerImage: 'ubuntu-24.04',
    });
  });

  test('paid record with no artifacts holds nulls', () => {
    const out = tempDir();
    const file = join(out, 'record.json');
    const result = run([
      'record',
      '--out',
      out,
      '--arm',
      'armA',
      '--sample',
      '3',
      '--mode',
      'paid',
      '--exit',
      '1',
      '--wall',
      '1',
      '--image',
      'img',
      '--file',
      file,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(record.valid, null);
    assert.equal(record.costUsd, null);
  });

  test('dry run record holds nulls', () => {
    const out = tempDir();
    const file = join(out, 'record.json');
    run([
      'record',
      '--out',
      out,
      '--arm',
      'b',
      '--sample',
      '2',
      '--mode',
      'dry-run',
      '--exit',
      '0',
      '--wall',
      '0',
      '--image',
      'img',
      '--file',
      file,
    ]);
    const record = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(record.valid, null);
    assert.equal(record.costUsd, null);
    assert.equal(record.mode, 'dry-run');
  });

  test('refuses bad flags with exit 2', () => {
    const out = tempDir();
    const base = [
      '--out',
      out,
      '--arm',
      'a',
      '--image',
      'i',
      '--file',
      join(out, 'f.json'),
    ];
    const good = [
      '--sample',
      '1',
      '--mode',
      'paid',
      '--exit',
      '0',
      '--wall',
      '1',
    ];
    const swap = (flag, value) => {
      const args = [...good];
      args[args.indexOf(flag) + 1] = value;
      return run(['record', ...base, ...args]).status;
    };
    assert.equal(swap('--mode', 'free'), 2);
    assert.equal(swap('--sample', '1.5'), 2);
    assert.equal(swap('--exit', 'x'), 2);
    assert.equal(swap('--wall', '-1'), 2);
  });
});
