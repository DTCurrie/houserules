import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaseError, measureCase } from '../timing.mjs';

const node = (name, code, extra = {}) => ({
  name,
  command: process.execPath,
  args: ['-e', code],
  cwd: process.cwd(),
  ...extra,
});

test('returns one positive sample per timed run', () => {
  const { samplesMs } = measureCase(node('ok', '0'), { warmup: 1, runs: 3 });
  assert.equal(samplesMs.length, 3);
  for (const s of samplesMs) {
    assert.equal(typeof s, 'number');
    assert.ok(s > 0);
  }
});

test('beforeEach runs before every run, warmup included', () => {
  let calls = 0;
  measureCase(node('hook', '0', { beforeEach: () => calls++ }), {
    warmup: 2,
    runs: 3,
  });
  assert.equal(calls, 5);
});

test('stdin reaches the child and env merges over process.env', () => {
  const code = `
    let d = '';
    process.stdin.on('data', (c) => (d += c));
    process.stdin.on('end', () => process.exit(d === 'hello' && process.env.BENCH_X === '1' && process.env.PATH ? 0 : 1));
  `;
  const { samplesMs } = measureCase(
    node('stdin', code, { stdin: 'hello', env: { BENCH_X: '1' } }),
    {
      warmup: 0,
      runs: 1,
    },
  );
  assert.equal(samplesMs.length, 1);
});

test('expectExit accepts a listed nonzero status', () => {
  const { samplesMs } = measureCase(
    node('two', 'process.exit(2)', { expectExit: [2] }),
    { warmup: 0, runs: 2 },
  );
  assert.equal(samplesMs.length, 2);
});

test('an unexpected exit throws CaseError carrying the stderr tail', () => {
  const code = `console.error('boom-marker'); process.exit(3)`;
  assert.throws(
    () => measureCase(node('bad-case', code), { warmup: 0, runs: 1 }),
    (e) =>
      e instanceof CaseError &&
      e.name === 'CaseError' &&
      e.message.includes('bad-case') &&
      e.message.includes('boom-marker'),
  );
});

test('only the last 20 lines of stderr are kept', () => {
  const code = `for (let i = 0; i < 40; i++) console.error('line-' + i); process.exit(1)`;
  assert.throws(
    () => measureCase(node('tail', code), { warmup: 0, runs: 1 }),
    (e) =>
      e.message.includes('line-39') &&
      e.message.includes('line-20') &&
      !e.message.includes('line-19\n'),
  );
});

test('a timeout throws CaseError', () => {
  assert.throws(
    () =>
      measureCase(
        node('slow', 'setTimeout(() => {}, 10000)', { timeoutMs: 300 }),
        { warmup: 0, runs: 1 },
      ),
    (e) => e instanceof CaseError && e.message.includes('slow'),
  );
});

test('a signal death throws CaseError', () => {
  assert.throws(
    () =>
      measureCase(node('sig', "process.kill(process.pid, 'SIGKILL')"), {
        warmup: 0,
        runs: 1,
      }),
    (e) => e instanceof CaseError && e.message.includes('SIGKILL'),
  );
});
