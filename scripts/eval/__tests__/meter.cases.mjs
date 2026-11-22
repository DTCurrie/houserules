import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LEDGER, LOCK } from '../layout.mjs';
import {
  chargeFor,
  readLedger,
  requirePaidFlags,
  runMetered,
  withLock,
} from '../meter.mjs';
import { writeStubClaude } from './stub-claude.mjs';

const SAMPLE_JOBS = Array.from({ length: 7 }, (_, index) => ({
  sample: index + 1,
}));

function freshOut() {
  const out = join(mkdtempSync(join(tmpdir(), 'hr-eval-meter-')), 'out');
  mkdirSync(out);
  return out;
}

/**
 * A `start` that spawns a stub `claude` printing `stdoutLines`, and counts its spawns.
 *
 * @param {string[]} stdoutLines
 */
function stubStart(stdoutLines) {
  const body = `for (const line of ${JSON.stringify(stdoutLines)}) console.log(line);`;
  const { path } = writeStubClaude(body);
  const counter = { spawned: 0 };
  async function start() {
    counter.spawned += 1;
    const child = spawn('claude', [], { env: { ...process.env, PATH: path } });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    await new Promise((resolve) => child.on('close', resolve));
    const events = stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
    const resultEvent = events.find((event) => event.type === 'result') ?? null;
    return { sessionId: resultEvent?.session_id ?? null, resultEvent };
  }
  return { start, counter };
}

const resultLine = (fields) =>
  JSON.stringify({ type: 'result', session_id: 's1', ...fields });

function meterOptions(out, start, overrides = {}) {
  return {
    out,
    budget: 15,
    perRun: 3,
    margin: 0,
    jobs: SAMPLE_JOBS,
    start,
    ...overrides,
  };
}

describe('meter: budget', () => {
  it('starts exactly 5 sessions at $2.50 with budget 15 and per-run 3', async () => {
    const out = freshOut();
    const { start, counter } = stubStart([
      resultLine({ subtype: 'success', total_cost_usd: 2.5 }),
    ]);
    const { started, refused } = await runMetered(meterOptions(out, start));
    assert.equal(counter.spawned, 5);
    assert.equal(started.length, 5);
    assert.deepEqual(refused, { sample: 6 });
    assert.equal(readLedger(out).length, 5);
  });

  it('charges the per-run cap when no result line is printed', async () => {
    const out = freshOut();
    const { start } = stubStart(['{"type":"system"}']);
    await runMetered(meterOptions(out, start, { jobs: [{ sample: 1 }] }));
    assert.equal(readLedger(out)[0].costUsd, 3);
  });

  it('charges the reported cost, 3.40', async () => {
    const out = freshOut();
    const { start } = stubStart([
      resultLine({ subtype: 'success', total_cost_usd: 3.4 }),
    ]);
    await runMetered(meterOptions(out, start, { jobs: [{ sample: 1 }] }));
    assert.equal(readLedger(out)[0].costUsd, 3.4);
    assert.equal(readLedger(out)[0].sessionId, 's1');
  });

  it('charges the cap, not 0, for a success result without total_cost_usd', async () => {
    const out = freshOut();
    const { start } = stubStart([resultLine({ subtype: 'success' })]);
    await runMetered(meterOptions(out, start, { jobs: [{ sample: 1 }] }));
    assert.equal(readLedger(out)[0].costUsd, 3);
    assert.equal(chargeFor({ subtype: 'success' }, 3), 3);
  });

  it('starts one more over a ledger holding four $2.50 lines', async () => {
    const out = freshOut();
    const first = stubStart([
      resultLine({ subtype: 'success', total_cost_usd: 2.5 }),
    ]);
    await runMetered(
      meterOptions(out, first.start, { jobs: SAMPLE_JOBS.slice(0, 4) }),
    );
    assert.equal(readLedger(out).length, 4);
    const second = stubStart([
      resultLine({ subtype: 'success', total_cost_usd: 2.5 }),
    ]);
    const { started } = await runMetered(meterOptions(out, second.start));
    assert.equal(second.counter.spawned, 1);
    assert.equal(started.length, 1);
  });

  it('does not refuse a job that fits when float sums are inexact', async () => {
    const out = freshOut();
    appendLedger(out, [0.1, 0.2]);
    const { start, counter } = stubStart([
      resultLine({ subtype: 'success', total_cost_usd: 0.1 }),
    ]);
    await runMetered(
      meterOptions(out, start, {
        budget: 0.6,
        perRun: 0.3,
        jobs: [{ sample: 1 }],
      }),
    );
    assert.equal(counter.spawned, 1);
  });

  it('skips blank ledger lines', () => {
    const out = freshOut();
    appendLedger(out, [1]);
    appendFileSync(join(out, LEDGER), '\n\n');
    assert.equal(readLedger(out).length, 1);
  });
});

function appendLedger(out, costs) {
  for (const costUsd of costs) {
    appendFileSync(
      join(out, LEDGER),
      `${JSON.stringify({ sample: 0, sessionId: null, costUsd })}\n`,
    );
  }
}

describe('meter: paid flags', () => {
  it('throws naming the missing margin', () => {
    assert.throws(() => requirePaidFlags({ budget: 15, perRun: 3 }), /margin/);
  });

  it('accepts all three flags', () => {
    requirePaidFlags({ budget: 15, perRun: 3, margin: 0 });
  });

  it('starts no session when the flow checks the flags first', async () => {
    const { start, counter } = stubStart([
      resultLine({ subtype: 'success', total_cost_usd: 1 }),
    ]);
    await assert.rejects(async () => {
      requirePaidFlags({ budget: 15, perRun: 3 });
      await runMetered(meterOptions(freshOut(), start));
    });
    assert.equal(counter.spawned, 0);
  });
});

describe('meter: lock', () => {
  it('refuses with no session started when the lock holds a live pid', async () => {
    const out = freshOut();
    await withLock(out, async () => {});
    writeFileSync(join(out, LOCK), String(process.pid));
    const { start, counter } = stubStart([
      resultLine({ subtype: 'success', total_cost_usd: 1 }),
    ]);
    await assert.rejects(
      withLock(out, () => runMetered(meterOptions(out, start))),
      /running pid/,
    );
    assert.equal(counter.spawned, 0);
    assert.equal(readFileSync(join(out, LOCK), 'utf8'), String(process.pid));
  });

  it('removes a lock holding an exited pid and starts the sessions', async () => {
    const out = freshOut();
    await withLock(out, async () => {});
    const exited = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => exited.on('close', resolve));
    writeFileSync(join(out, LOCK), String(exited.pid));
    const { start, counter } = stubStart([
      resultLine({ subtype: 'success', total_cost_usd: 2.5 }),
    ]);
    await withLock(out, () => runMetered(meterOptions(out, start)));
    assert.equal(counter.spawned, 5);
    assert.equal(existsSync(join(out, LOCK)), false);
  });

  it('removes its own lock when fn throws', async () => {
    const out = freshOut();
    await assert.rejects(
      withLock(out, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(existsSync(join(out, LOCK)), false);
  });
});
