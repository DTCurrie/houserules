import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadArmFixture } from '../fixture-arm.mjs';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'worker-ladder-multi',
);
const ARMS = ['haiku', 'sonnet', 'opus'];
const ACCEPTANCE =
  'node --test test/invoice.test.js test/invoice-format.test.js';
const HIDDEN = 'node --test --test-reporter=tap test/invoice.hidden.test.js';
const FAILING_AT_START = [
  'prints the receipt for a discounted two-line order',
  'splits a coupon so the line discounts sum to the invoice discount',
  'taxes a line on its price after the discount',
];
const temps = [];

function envOutsideParentRun() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function sampleRoot(invoiceSource) {
  const root = mkdtempSync(join(tmpdir(), 'hr-worker-ladder-multi-'));
  temps.push(root);
  cpSync(join(FIXTURE, 'repo'), root, { recursive: true });
  cpSync(join(FIXTURE, 'hidden', 'test'), join(root, 'test'), {
    recursive: true,
  });
  if (invoiceSource)
    cpSync(
      join(FIXTURE, 'hidden', invoiceSource, 'invoice.js'),
      join(root, 'src', 'invoice.js'),
    );
  return root;
}

function run(root, command) {
  const result = spawnSync('sh', ['-c', `${command} 2>&1`], {
    cwd: root,
    env: envOutsideParentRun(),
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout };
}

const failingLeaves = (tapOutput) =>
  [...tapOutput.matchAll(/^ {4}not ok \d+ - (.+)$/gm)].map((match) => match[1]);

function scoreSelftest() {
  const out = mkdtempSync(join(tmpdir(), 'hr-worker-ladder-multi-score-'));
  temps.push(out);
  const built = spawnSync(
    process.execPath,
    [join(FIXTURE, 'make-selftest.mjs'), out],
    { encoding: 'utf8' },
  );
  assert.equal(built.status, 0, built.stderr);
  const scored = spawnSync(
    process.execPath,
    [join(FIXTURE, 'score.mjs'), out],
    { env: envOutsideParentRun(), encoding: 'utf8' },
  );
  assert.equal(scored.status, 0, scored.stderr);
  const rows = scored.stdout
    .split('\n')
    .filter((line) => line.startsWith('JSON '))
    .map((line) => JSON.parse(line.slice('JSON '.length)));
  return Object.fromEntries(rows.map((row) => [row.arm, row]));
}

describe('worker-ladder-multi fixture', () => {
  after(() => {
    for (const root of temps) rmSync(root, { recursive: true, force: true });
  });

  it('loads one arm per worker tier through the runner loader', () => {
    const spec = JSON.parse(readFileSync(join(FIXTURE, 'eval.json'), 'utf8'));

    const arms = ARMS.map((arm) => loadArmFixture(FIXTURE, arm));

    assert.deepEqual(Object.keys(spec.arms), ARMS);
    assert.deepEqual(
      arms.map((arm) => [arm.arm, arm.model, arm.validityAgent]),
      ARMS.map((arm) => [arm, 'sonnet', 'task-worker']),
    );
  });

  it('pins each arm task-worker to its tier and changes nothing else', () => {
    const overlays = ARMS.map((arm) =>
      readFileSync(
        join(FIXTURE, 'arms', arm, 'overlay', 'agents', 'task-worker.md'),
        'utf8',
      ),
    );

    const models = overlays.map((text) => /^model: (\S+)$/m.exec(text)?.[1]);
    const unpinned = overlays.map((text) =>
      text.replace(/^model: \S+$/m, 'model: X'),
    );

    assert.deepEqual(models, ARMS);
    assert.deepEqual(unpinned, [unpinned[0], unpinned[0], unpinned[0]]);
  });

  it('gives every arm the same prompt, naming the acceptance and the owned path', () => {
    const prompts = ARMS.map((arm) =>
      readFileSync(join(FIXTURE, 'arms', arm, 'prompt.txt'), 'utf8'),
    );

    assert.deepEqual(prompts, [prompts[0], prompts[0], prompts[0]]);
    assert.ok(
      prompts[0].includes(`Acceptance: \`${ACCEPTANCE}\` passes.`),
      'prompt names the acceptance command',
    );
    assert.ok(
      prompts[0].includes('Owned paths: `src/invoice.js` only.'),
      'prompt names the owned path',
    );
  });

  it('fails the visible acceptance on the starting repo with assertion errors, not a missing module', () => {
    const { status, output } = run(sampleRoot(null), ACCEPTANCE);

    assert.equal(status, 1, output);
    assert.deepEqual(
      FAILING_AT_START.filter((name) => !output.includes(`✖ ${name}`)),
      [],
      output,
    );
    assert.ok(output.includes('ERR_ASSERTION'), output);
    assert.ok(!output.includes('ERR_MODULE_NOT_FOUND'), output);
  });

  it('passes the visible acceptance with the reference solution', () => {
    const { status, output } = run(sampleRoot('solution'), ACCEPTANCE);

    assert.equal(status, 0, output);
  });

  it('passes the hidden tests with the reference solution', () => {
    const { status, output } = run(sampleRoot('solution'), HIDDEN);

    assert.equal(status, 0, failingLeaves(output).join('\n') || output);
  });

  it('passes the visible acceptance with the test-only fix', () => {
    const { status, output } = run(sampleRoot('wrong'), ACCEPTANCE);

    assert.equal(status, 0, output);
  });

  it('fails the hidden tests with the test-only fix, across the contract rules', () => {
    const { status, output } = run(sampleRoot('wrong'), HIDDEN);

    assert.equal(status, 1, output);
    assert.deepEqual(failingLeaves(output), [
      'rejects qty 0',
      'rejects qty 1.5',
      'rejects qty 2',
      'rejects unitCents 1000',
      'merges repeated skus into the first line, summing qty',
      'rejects one sku at two unit prices',
      'gives a gift card no share of the coupon',
      'caps the coupon at the discountable gross',
      'applies no discount to an order of gift cards only',
      'splits by gross after merging repeated skus',
      'rounds an exact half cent down to even',
      'rounds tax per line, not on the total',
      'totals a mixed order with a coupon and a gift card',
    ]);
  });

  it('scores the selftest samples with the holds rule', () => {
    const rows = scoreSelftest();

    assert.deepEqual(
      ['solution', 'wrong', 'start'].map((label) => [
        label,
        rows[label].valid,
        rows[label].hidden,
        rows[label].visible,
        rows[label].acceptanceRanAfterLastEdit,
        rows[label].mainEdited,
        rows[label].outsideEdits,
        rows[label].holds,
      ]),
      [
        ['solution', true, 'PASS', 'PASS', true, false, [], 'PASS'],
        ['wrong', true, 'FAIL', 'PASS', false, true, ['tax-rates.js'], 'FAIL'],
        ['start', true, 'FAIL', 'FAIL', false, false, [], 'FAIL'],
      ],
    );
  });
});
