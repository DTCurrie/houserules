import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../health-kit/closeout/metrics-table.mjs', import.meta.url),
);

function doctor({
  claude = 1900,
  descriptions = 900,
  style = 1200,
  largest = 19000,
}) {
  return [
    '· houserules doctor',
    claude == null
      ? null
      : `· resident context (CLAUDE.md): ~${claude} tokens / 137 lines vs budget ~4000 / 200 — 2062 tokens, 63 lines headroom`,
    '· nested (on-demand, not in resident total): packages/api/CLAUDE.md',
    `· resident skill/agent descriptions (9 skill(s) + 11 agent(s)): ~${descriptions} tokens`,
    `· resident output style (Prose): ~${style} tokens`,
    `· 11 installed skills measured, largest body ${largest} bytes`,
    '',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function report({ p95, blocks }) {
  return [
    '  Stop hooks (every stop_hook_summary, quiet runs included):',
    '  hook                 runs  p50ms  p95ms  over 1s     maxms  timeouts',
    '  -------------------  ----  -----  -----  ----------  -----  --------',
    '  changeset-check.mjs  284   38     122    0 (0.00%)   339    0       ',
    `  lint-format-fix.mjs  284   48     ${p95}   22 (7.75%)  6817   0       `,
    '  (per Stop total)     284   154    4784   23 (8.10%)  7066   0       ',
    '',
    '-- guard efficacy --',
    '',
    '  guard            reason                      blocks',
    '  ---------------  --------------------------  ------',
    ...blocks.map(
      (n, i) =>
        `  PreToolUse:Bash  git thing number ${i} is blocked.  ${n}     `,
    ),
    '',
    '  29b0e240  blocked: git stash list',
    '',
  ].join('\n');
}

function setup(files) {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-table-'));
  return files.map((text, i) => {
    const path = join(dir, `capture-${i}.txt`);
    writeFileSync(path, text);
    return path;
  });
}

function run(paths) {
  return spawnSync(process.execPath, [SCRIPT, ...paths], { encoding: 'utf8' });
}

describe('metrics-table', () => {
  it('prints all four rows for a full run', () => {
    const paths = setup([
      doctor({ claude: 2000, descriptions: 900, style: 1200, largest: 19799 }),
      doctor({ claude: 1800, descriptions: 950, style: 1200, largest: 15000 }),
      report({ p95: 5400, blocks: [4, 3, 2] }),
      report({ p95: 4300, blocks: [5, 1] }),
    ]);
    const result = run(paths);
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      [
        '| metric | before | after | delta |',
        '| --- | --- | --- | --- |',
        '| always-loaded total (tokens) | 4100 | 3950 | -150 |',
        '| largest skill body (bytes) | 19799 | 15000 | -4799 |',
        '| lint-format-fix.mjs Stop p95 (ms) | 5400 | 4300 | -1100 |',
        '| guard blocks | 9 | 6 | -3 |',
        '',
      ].join('\n'),
    );
  });

  it('reports the total as not captured when a resident line is missing', () => {
    const paths = setup([doctor({ claude: null }), doctor({ claude: 1800 })]);
    const lines = run(paths).stdout.split('\n');
    assert.equal(
      lines[2],
      '| always-loaded total (tokens) | not captured | 3900 | not captured |',
    );
    assert.equal(
      lines[3],
      '| largest skill body (bytes) | 19000 | 19000 | 0 |',
    );
  });

  it('reports report rows as not captured on a two-arg run', () => {
    const lines = run(
      setup([doctor({}), doctor({ style: 1300 })]),
    ).stdout.split('\n');
    assert.equal(
      lines[2],
      '| always-loaded total (tokens) | 4000 | 4100 | +100 |',
    );
    assert.equal(
      lines[4],
      '| lint-format-fix.mjs Stop p95 (ms) | not captured | not captured | not captured |',
    );
    assert.equal(
      lines[5],
      '| guard blocks | not captured | not captured | not captured |',
    );
  });

  it('exits 2 on a wrong argument count or an unreadable file', () => {
    const [a] = setup([doctor({})]);
    const wrongCount = run([a]);
    assert.equal(wrongCount.status, 2);
    assert.match(wrongCount.stderr, /usage:/);
    const unreadable = run([
      a,
      join(tmpdir(), 'metrics-table-missing-file.txt'),
    ]);
    assert.equal(unreadable.status, 2);
    assert.match(unreadable.stderr, /usage:/);
  });
});
