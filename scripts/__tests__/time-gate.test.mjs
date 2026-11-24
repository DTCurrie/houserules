import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  attributeScriptSeconds,
  pnpmSpawnOptions,
  table,
  withShares,
} from '../time-gate.mjs';

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

const THREE_ROWS = [
  { script: 'a', outcome: 'ran', seconds: 5 },
  { script: 'b', outcome: 'ran', seconds: 2 },
  { script: 'c', outcome: 'fresh', seconds: 0.5 },
];

describe('withShares', () => {
  it('gives each script its share of the wall and its gap to the next-longest', () => {
    const rows = withShares(THREE_ROWS, 8);

    assert.deepEqual(
      rows.map(({ share, gapSeconds }) => ({ share, gapSeconds })),
      [
        { share: 0.625, gapSeconds: 3 },
        { share: 0.25, gapSeconds: 1.5 },
        { share: 0.063, gapSeconds: null },
      ],
    );
  });

  it('gives a share of 0 when the wall is 0', () => {
    const [row] = withShares([{ script: 'a', outcome: 'ran', seconds: 0 }], 0);

    assert.equal(row.share, 0);
  });
});

describe('table', () => {
  it('prints share and gap columns and ends with a total row holding the wall', () => {
    const text = table(withShares(THREE_ROWS, 8), 8);

    assert.equal(
      text,
      [
        'script  outcome     seconds  share  gap s',
        'a       ran            5.00  62.5%  3.00',
        'b       ran            2.00  25.0%  1.50',
        'c       fresh          0.50   6.3%  -',
        'total                  8.00',
        '',
      ].join('\n'),
    );
  });
});

describe('pnpmSpawnOptions', () => {
  it('starts pnpm through a shell on win32', () => {
    assert.equal(pnpmSpawnOptions('win32').shell, true);
  });

  it('starts pnpm without a shell on darwin', () => {
    assert.equal(pnpmSpawnOptions('darwin').shell, false);
  });
});

const PRINTED_SECONDS_TOLERANCE = 0.01;

function assertPrinted(stdout, pattern, expectedSeconds) {
  const printed = Number(stdout.match(pattern)?.[1]);
  assert.ok(
    Math.abs(printed - expectedSeconds) <= PRINTED_SECONDS_TOLERANCE,
    `printed ${printed}, row ${expectedSeconds}`,
  );
}

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
    assert.equal(rows[1].gapSeconds, null);
    assert.equal(rows[1].share, 0);
    assert.ok(rows[0].wallSeconds >= 0.9 && rows[0].wallSeconds < 5);
    assert.equal(rows[0].wallSeconds, rows[1].wallSeconds);
    assert.equal(rows[0].gapSeconds, rows[0].seconds);
    assert.equal(rows[0].gate, 'check');
    assert.equal(rows[0].script, 's:one');
    assert.equal(rows[0].outcome, 'ran');
    assert.ok(rows[0].seconds >= 0.9 && rows[0].seconds < 3);
    assert.equal(rows[1].script, 's:two');
    assert.equal(rows[1].seconds, 0);
    assertPrinted(result.stdout, /s:one\s+ran\s+(\d+\.\d\d)/, rows[0].seconds);
    assertPrinted(
      result.stdout,
      /\ntotal\s+(\d+\.\d\d)\n/,
      rows[0].wallSeconds,
    );
  });
});
