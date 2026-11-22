import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attributeScriptSeconds } from '../time-gate.mjs';

const SCRIPT = fileURLToPath(new URL('../time-gate.mjs', import.meta.url));

const LOG = [
  [0, '$ wireit'],
  [
    10,
    '🏃 [verify:package-manifests] Running command "node scripts/verify-package-manifests.mjs"',
  ],
  [12, '🏃 [verify:knip] Running command "knip --include files,dependencies"'],
  [15, '✅ [packages/create:build] Already fresh'],
  [20, '17/17 package manifests passed'],
  [1510, '✅ [verify:package-manifests] Executed successfully'],
  [
    1520,
    '🏃 [packages/cli:build:ts] Running command "tsc -p tsconfig.build.json"',
  ],
  [3012, 'Unused files (1)'],
  [3012, '❌ [verify:knip] Failed with exit status 1'],
  [4720, '✅ [packages/cli:build:ts] Executed successfully'],
  [4521, '✅ [check:types] No command to execute'],
  [4522, '[ELIFECYCLE] Command failed with exit code 1.'],
].map(([arrivedMs, text]) => ({ arrivedMs, text }));

const EXPECTED = [
  { script: 'packages/cli:build:ts', outcome: 'ran', seconds: 3.2 },
  { script: 'verify:knip', outcome: 'failed', seconds: 3 },
  { script: 'verify:package-manifests', outcome: 'ran', seconds: 1.5 },
  { script: 'packages/create:build', outcome: 'fresh', seconds: 0 },
  { script: 'check:types', outcome: 'no-command', seconds: 0 },
];

describe('attributeScriptSeconds', () => {
  it('names seconds per script, slowest first', () => {
    assert.deepEqual(attributeScriptSeconds(LOG), EXPECTED);
  });

  it('marks a script that never ended', () => {
    const rows = attributeScriptSeconds([
      { arrivedMs: 0, text: '🏃 [a] Running command "x"' },
      { arrivedMs: 2000, text: '✅ [b] Already fresh' },
    ]);
    assert.deepEqual(rows, [
      { script: 'a', outcome: 'unfinished', seconds: 2 },
      { script: 'b', outcome: 'fresh', seconds: 0 },
    ]);
  });
});

describe('--out', () => {
  it('writes one jsonl row per script and exits with pnpm status', () => {
    const dir = mkdtempSync(join(tmpdir(), 'time-gate-'));
    const fake = join(dir, 'pnpm');
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        'echo "🏃 [s:one] Running command \\"x\\""',
        'sleep 1',
        'echo "✅ [s:one] Executed successfully"',
        'echo "✅ [s:two] Already fresh"',
        'exit 3',
        '',
      ].join('\n'),
    );
    chmodSync(fake, 0o755);
    const out = join(dir, 'nested', 'rows.jsonl');
    const result = spawnSync('node', [SCRIPT, 'check', '--out', out], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.equal(result.status, 3);
    const rows = readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].gate, 'check');
    assert.equal(rows[0].script, 's:one');
    assert.equal(rows[0].outcome, 'ran');
    assert.ok(rows[0].seconds >= 0.9 && rows[0].seconds < 3);
    assert.equal(rows[1].script, 's:two');
    assert.equal(rows[1].seconds, 0);
    assert.match(result.stdout, /s:one\s+ran\s+1\./);
  });
});
