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
  'check-once',
);
const ENTRY_LINES = [
  '- Before writing a file or document the user asked for, read only what the ask names, write a',
  '  first version, then check it once.',
];
const temps = [];

const read = (...parts) => readFileSync(join(FIXTURE, ...parts), 'utf8');

function toolUse(name, input) {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_x', name, input }] },
  };
}

function writeSample(out, arm, sample, { events, overlaySha }) {
  const dir = join(out, arm, `sample-${sample}`);
  mkdirSync(join(dir, 'tree'), { recursive: true });
  writeFileSync(join(dir, 'tree', 'prompt.md'), 'Run the report command.\n');
  writeFileSync(
    join(dir, 'stream.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify({
      overlays: [
        {
          path: 'houserules.md',
          initSha256: 'a',
          overlaySha256: 'b',
          exitSha256: overlaySha,
        },
      ],
    }),
  );
}

describe('check-once fixture', () => {
  after(() => {
    for (const dir of temps) rmSync(dir, { recursive: true, force: true });
  });

  it('declares two arms that each name a prompt and an overlay', () => {
    const spec = JSON.parse(read('eval.json'));
    assert.deepEqual(Object.keys(spec.arms).sort(), ['control', 'entry']);
    for (const arm of Object.values(spec.arms)) {
      assert.ok(arm.prompt.endsWith('prompt.txt'));
      assert.ok(arm.overlay.endsWith('overlay'));
    }
    assert.deepEqual(spec.collect, ['prompt.md']);
  });

  it('differs between the arms only by the check-once entry', () => {
    const entry = read('arms', 'entry', 'overlay', 'houserules.md').split('\n');
    const control = read('arms', 'control', 'overlay', 'houserules.md').split(
      '\n',
    );
    const at = entry.indexOf(ENTRY_LINES[0]);
    assert.ok(at >= 0);
    assert.deepEqual(entry.slice(at, at + 2), ENTRY_LINES);
    assert.deepEqual(entry.toSpliced(at, 2), control);
    assert.ok(!control.includes(ENTRY_LINES[0]));
  });

  it('gives both arms the same prompt', () => {
    const prompt = read('arms', 'entry', 'prompt.txt');
    assert.equal(read('arms', 'control', 'prompt.txt'), prompt);
    assert.ok(prompt.includes('report command'));
  });

  it('scores calls before the first write, total calls, wall, cost, and the prompt file', () => {
    const out = mkdtempSync(join(tmpdir(), 'hr-check-once-'));
    temps.push(out);
    writeSample(out, 'entry', 1, {
      overlaySha: 'b',
      events: [
        toolUse('Read', { file_path: '/r/README.md' }),
        toolUse('Bash', { command: 'ls' }),
        toolUse('Write', { file_path: '/r/prompt.md', content: 'x' }),
        toolUse('Read', { file_path: '/r/prompt.md' }),
        {
          type: 'result',
          subtype: 'success',
          duration_ms: 12500,
          total_cost_usd: 0.4321987,
        },
      ],
    });
    writeSample(out, 'control', 1, {
      overlaySha: 'changed',
      events: [
        toolUse('Bash', { command: 'cat > prompt.md <<EOF\nhi\nEOF' }),
        { type: 'result', subtype: 'success', duration_ms: 3000 },
      ],
    });
    writeFileSync(
      join(out, 'spend.jsonl'),
      `${JSON.stringify({ arm: 'control', sample: 1, costUsd: 0.25 })}\n`,
    );
    const run = spawnSync(process.execPath, [join(FIXTURE, 'score.mjs'), out], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const lines = run.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'arm\tsample\tvalid\tcallsBeforeFirstWrite\ttotalCalls\twallS\tcostUsd\tpromptExists',
    );
    assert.equal(lines[1], 'control\t1\tfalse\t0\t1\t3\t0.25\ttrue');
    assert.equal(lines[3], 'entry\t1\ttrue\t2\t4\t12.5\t0.4322\ttrue');
  });
});
