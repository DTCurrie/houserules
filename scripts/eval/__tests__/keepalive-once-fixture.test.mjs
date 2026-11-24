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

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'keepalive-once',
);
const SENTENCE =
  ' Start a keepalive only when none from this turn chain is still running.';
const OVERLAY = 'overlay/agents/phase-orchestrator.md';
const temps = [];

const read = (...parts) => readFileSync(join(FIXTURE, ...parts), 'utf8');

function toolUse(id, name, input) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
    },
  };
}

function toolResult(id, content) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content }],
    },
  };
}

const background = (id) =>
  toolUse(id, 'Bash', { command: 'sleep 5', run_in_background: true });
const started = (id, taskId) =>
  toolResult(
    id,
    `Command running in background with ID: ${taskId}. Output is being written to: /x`,
  );
const finished = (taskId) => ({
  type: 'user',
  message: {
    role: 'user',
    content: `<task-notification><task-id>${taskId}</task-id><status>completed</status></task-notification>`,
  },
});
const dispatch = (id) =>
  toolUse(id, 'Agent', { subagent_type: 'task-worker', prompt: 'slice' });

function writeJsonl(path, records) {
  writeFileSync(
    path,
    records.map((record) => JSON.stringify(record)).join('\n'),
  );
}

const requestEcho = (...records) => ({
  type: 'api-request-blob',
  message: {
    role: 'user',
    content: records.flatMap((record) => record.message.content),
  },
});

function syntheticSample(echo = []) {
  const dir = mkdtempSync(join(tmpdir(), 'hr-keepalive-once-'));
  temps.push(dir);
  const sample = join(dir, 'with', 'sample-1');
  const subagents = join(sample, 'transcripts', 'session-1', 'subagents');
  mkdirSync(subagents, { recursive: true });
  writeFileSync(
    join(sample, 'run.json'),
    JSON.stringify({ arm: 'with', sample: 1 }),
  );
  writeJsonl(join(sample, 'stream.jsonl'), [
    { type: 'system', timestamp: '2026-11-24T02:00:00.000Z' },
    { type: 'result', total_cost_usd: 0.5, duration_ms: 40 },
  ]);
  writeJsonl(join(subagents, 'agent-po.jsonl'), [
    dispatch('w1'),
    dispatch('w2'),
    toolUse('b0', 'Bash', { command: 'npm test' }),
    background('k1'),
    started('k1', 'bkeep1'),
    background('k2'),
    started('k2', 'bkeep2'),
    finished('bkeep1'),
    finished('bkeep2'),
    dispatch('w3'),
    background('k3'),
    started('k3', 'bkeep3'),
    ...echo,
    { type: 'system', timestamp: '2026-11-24T02:01:30.000Z' },
  ]);
  writeFileSync(
    join(subagents, 'agent-po.meta.json'),
    JSON.stringify({ agentType: 'phase-orchestrator' }),
  );
  writeJsonl(join(subagents, 'agent-tw.jsonl'), [
    background('x1'),
    background('x2'),
  ]);
  writeFileSync(
    join(subagents, 'agent-tw.meta.json'),
    JSON.stringify({ agentType: 'task-worker' }),
  );
  return dir;
}

describe('keepalive-once fixture', () => {
  after(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('declares the without and with arms against the phase-orchestrator', () => {
    const config = JSON.parse(read('eval.json'));
    assert.deepEqual(Object.keys(config.arms).sort(), ['with', 'without']);
    assert.equal(config.validityAgent, 'phase-orchestrator');
    for (const [name, arm] of Object.entries(config.arms)) {
      assert.equal(arm.prompt, `arms/${name}/prompt.txt`);
      assert.equal(arm.overlay, `arms/${name}/overlay`);
    }
  });

  it('differs between the overlays only at the keepalive sentence', () => {
    const withText = read('arms', 'with', OVERLAY);
    const withoutText = read('arms', 'without', OVERLAY);
    assert.equal(withText.split(SENTENCE).length - 1, 1);
    assert.equal(withoutText, withText.replace(SENTENCE, ''));
  });

  it('gives both arms the same nested orchestrate prompt', () => {
    const prompt = read('arms', 'with', 'prompt.txt');
    assert.equal(read('arms', 'without', 'prompt.txt'), prompt);
    assert.equal(prompt.trim(), '/orchestrate keepalive 1 --auto');
  });

  it('plans one phase with exactly two steps', () => {
    const phase = read(
      'repo',
      '.claude',
      'plans',
      'keepalive',
      'phase-1-helpers.md',
    );
    assert.equal(phase.match(/^- \[ \] \*\*Step \d+:/gm).length, 2);
  });

  it('counts launches, waves, and overlaps from the phase-orchestrator only', () => {
    const result = spawnSync(
      process.execPath,
      [join(FIXTURE, 'score.mjs'), syntheticSample()],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout
      .split('\n')
      .find((text) => text.startsWith('JSON '));
    const score = JSON.parse(line.slice('JSON '.length));
    assert.equal(score.launches, 3);
    assert.deepEqual(score.perWave, [0, 2, 1]);
    assert.equal(score.overlaps, 1);
    assert.equal(score.cost, 0.5);
    assert.equal(score.wallS, 90);
    assert.equal(score.arm, 'with');
  });

  it('ignores an api-request-blob record that echoes a launch', () => {
    const echo = requestEcho(dispatch('w3'), background('k3'));

    const result = spawnSync(
      process.execPath,
      [join(FIXTURE, 'score.mjs'), syntheticSample([echo])],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout
      .split('\n')
      .find((text) => text.startsWith('JSON '));
    const score = JSON.parse(line.slice('JSON '.length));
    assert.deepEqual(
      {
        launches: score.launches,
        perWave: score.perWave,
        overlaps: score.overlaps,
      },
      { launches: 3, perWave: [0, 2, 1], overlaps: 1 },
    );
  });

  it('exits 2 with usage when given no directory', () => {
    const result = spawnSync(process.execPath, [join(FIXTURE, 'score.mjs')], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /usage/);
  });
});
