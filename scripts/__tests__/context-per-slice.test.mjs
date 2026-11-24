import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../health-kit/gather/context-per-slice.mjs', import.meta.url),
);

const PLAN = 'demo-plan';

const usage = (input, read, creation) => ({
  input_tokens: input,
  cache_read_input_tokens: read,
  ...(creation === undefined ? {} : { cache_creation_input_tokens: creation }),
});
const assistant = (id, timestamp, tokens, blocks = []) => ({
  type: 'assistant',
  timestamp,
  message: {
    id,
    role: 'assistant',
    content: blocks,
    ...(tokens ? { usage: tokens } : {}),
  },
});
const agentCall = (toolId, type, prompt) => ({
  type: 'tool_use',
  id: toolId,
  name: 'Agent',
  input: { subagent_type: type, prompt },
});
const sendMessage = (toolId, to) => ({
  type: 'tool_use',
  id: toolId,
  name: 'SendMessage',
  input: { to, message: 'continue' },
});
const launched = (toolId, agentId) => ({
  type: 'user',
  toolUseResult: { isAsync: true, agentId },
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }],
  },
});
const handback = (agentId) => ({
  type: 'user',
  origin: { kind: 'peer', from: agentId, handback: true },
  message: { role: 'user', content: '<report>' },
});

const phasePrompt = (phase, plan = PLAN) =>
  `Plan: ${plan}\nPhase: ${phase}\nMode: auto`;

const PHASE_ONE = [
  '# Phase 1',
  '',
  '## Slices',
  '',
  '| id | owns | depends | wave | status |',
  '| --- | ---- | ------- | ---- | ------ |',
  '| 1a | `a.ts` | none | 1 | DONE |',
  '| 1b | `b.ts` | none | 1 | DONE |',
  '| tidy-1 | none | 1a,1b | 1 | DONE |',
  '| 2a | `c.ts` | 1a | 2 | DONE |',
  '',
  '## Notes',
  '',
  '| 9z | `ignored.ts` | none | 1 | DONE |',
].join('\n');
const PHASE_TWO = [
  '## Slices',
  '| id | owns | depends | wave | status |',
  '| --- | ---- | ------- | ---- | ------ |',
  '| 1a | `d.ts` | none | 1 | DONE |',
  '| 1b | `e.ts` | none | 1 | DONE |',
].join('\n');

function writeFixture(records, { planFiles = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'context-per-slice-'));
  const mainPath = join(root, 'session.jsonl');
  writeFileSync(
    mainPath,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\nnot json`,
  );
  if (planFiles) {
    writeFileSync(join(root, 'phase-1-first.md'), PHASE_ONE);
    writeFileSync(join(root, 'phase-2-second.md'), PHASE_TWO);
  }
  return { root, mainPath, out: join(root, 'out.json') };
}

function run({ root, mainPath, out }) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--plan', PLAN, '--plan-dir', root, '--json', out, mainPath],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout, json: JSON.parse(readFileSync(out, 'utf8')) };
}

const NESTED_SESSION = [
  assistant('m1', '2026-11-23T10:00:00.000Z', usage(10, 80, 10), [
    agentCall('t1', 'phase-orchestrator', phasePrompt(1)),
  ]),
  assistant('m1', '2026-11-23T10:00:01.000Z', usage(10, 80, 10), [
    agentCall('t2', 'phase-orchestrator', phasePrompt(2)),
  ]),
  assistant('m1', '2026-11-23T10:00:02.000Z', usage(10, 80, 10), [
    agentCall('t9', 'phase-orchestrator', phasePrompt(1, 'other-plan')),
  ]),
  launched('t1', 'A1'),
  launched('t2', 'A2'),
  assistant('m2', '2026-11-23T10:01:00.000Z', null, []),
  assistant('m3', '2026-11-23T10:02:00.000Z', usage(5, 120), [
    agentCall('t3', 'task-worker', 'do a thing'),
  ]),
  handback('A1'),
  assistant('m4', '2026-11-23T10:03:00.000Z', usage(0, 150, 50)),
  assistant('m5', '2026-11-23T10:04:00.000Z', usage(10, 190, 10), [
    sendMessage('t4', 'A1'),
  ]),
  handback('A1'),
  assistant('m6', '2026-11-23T10:05:00.000Z', usage(10, 200, 50)),
  handback('A2'),
  assistant('m7', '2026-11-23T10:06:00.000Z', usage(10, 160, 20)),
  assistant('m8', '2026-11-23T10:07:00.000Z', usage(10, 160, 20), [
    agentCall('t5', 'phase-orchestrator', phasePrompt(3)),
  ]),
  launched('t5', 'A3'),
];

describe('context-per-slice', () => {
  it('sums spawn and resume growth per phase and divides by slice rows that own files', () => {
    const { stdout, json } = run(writeFixture(NESTED_SESSION));

    assert.deepEqual(
      json.phases.map(({ phase, cycles, growth, slices, perSlice }) => ({
        phase,
        cycles,
        growth,
        slices,
        perSlice,
      })),
      [
        { phase: 1, cycles: 2, growth: 150, slices: 3, perSlice: 50 },
        { phase: 2, cycles: 1, growth: 90, slices: 2, perSlice: 45 },
      ],
    );
    assert.equal(json.mean, 48);
    assert.equal(json.median, 47.5);
    assert.match(stdout, /^mean per-slice: 48$/m);
    assert.match(stdout, /^open cycles left out: 1$/m);
  });

  it('counts a duplicated message id once and a missing usage field as zero', () => {
    const { json } = run(writeFixture(NESTED_SESSION));

    assert.deepEqual(
      json.cycles.map(({ phase, kind, before, after }) => [
        phase,
        kind,
        before,
        after,
      ]),
      [
        ['1', 'spawn', 100, 200],
        ['2', 'spawn', 100, 190],
        ['1', 'resume', 210, 260],
      ],
    );
  });

  it('reports the largest main context with the phases still open at that turn', () => {
    const { json } = run(writeFixture(NESTED_SESSION));

    assert.deepEqual(json.max, {
      context: 260,
      timestamp: '2026-11-23T10:05:00.000Z',
      openPhases: ['2'],
    });
    assert.equal(json.gate, null);
  });

  it('reports the first turn over the 300000 token gate', () => {
    const { json, stdout } = run(
      writeFixture([
        assistant('m1', '2026-11-23T10:00:00.000Z', usage(1, 299999, 0)),
        assistant('m2', '2026-11-23T10:01:00.000Z', usage(1, 300000, 0)),
        assistant('m3', '2026-11-23T10:02:00.000Z', usage(1, 400000, 0)),
      ]),
    );

    assert.deepEqual(json.gate, {
      context: 300001,
      timestamp: '2026-11-23T10:01:00.000Z',
      openPhases: [],
    });
    assert.match(
      stdout,
      /^first context over 300000: 300001 at 2026-11-23T10:01:00.000Z, phases open: none$/m,
    );
  });

  it('counts a direct task-worker dispatch from main', () => {
    const { json, stdout } = run(writeFixture(NESTED_SESSION));

    assert.equal(json.directDispatches, 1);
    assert.match(stdout, /^direct task-worker dispatches: 1$/m);
  });

  it('flags cycles that overlap another phase window', () => {
    const { json } = run(writeFixture(NESTED_SESSION));

    assert.deepEqual(
      json.cycles.map((cycle) => cycle.overlaps),
      [1, 2, 1],
    );
  });

  it('leaves a phase with no phase file at a question mark', () => {
    const { stdout, json } = run(
      writeFixture(NESTED_SESSION, { planFiles: false }),
    );

    assert.equal(json.phases[0].perSlice, null);
    assert.equal(json.mean, null);
    assert.match(stdout, /^1\s+2\s+150\s+\?\s+\?\s+no$/m);
  });

  it('reports no phases when the session never spawned one for the plan', () => {
    const { json } = run(
      writeFixture([
        assistant('m1', '2026-11-23T10:00:00.000Z', usage(1, 2, 3)),
      ]),
    );

    assert.deepEqual(json.phases, []);
    assert.equal(json.max.context, 6);
    assert.equal(json.directDispatches, 0);
  });

  it('drops a phase whose cycle spans a compaction and keeps one that finished before it', () => {
    const { json } = run(
      writeFixture([
        assistant('m1', '2026-11-23T10:00:00.000Z', usage(10, 80, 10), [
          agentCall('t2', 'phase-orchestrator', phasePrompt(2)),
        ]),
        launched('t2', 'A2'),
        handback('A2'),
        assistant('m2', '2026-11-23T10:01:00.000Z', usage(10, 100, 10), [
          agentCall('t1', 'phase-orchestrator', phasePrompt(1)),
        ]),
        launched('t1', 'A1'),
        handback('A1'),
        { type: 'system', subtype: 'compact_boundary' },
        assistant('m3', '2026-11-23T10:02:00.000Z', usage(5, 30, 5)),
      ]),
    );

    assert.deepEqual(
      json.phases.map(({ phase, growth, compacted, perSlice }) => ({
        phase,
        growth,
        compacted,
        perSlice,
      })),
      [
        { phase: 1, growth: 0, compacted: true, perSlice: null },
        { phase: 2, growth: 20, compacted: false, perSlice: 10 },
      ],
    );
    assert.equal(json.mean, 10);
  });

  it('exits 2 with a usage line when --plan is missing', () => {
    const result = spawnSync(process.execPath, [SCRIPT, 'x.jsonl'], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /^usage: node context-per-slice\.mjs/m);
  });
});
