import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { readStream, scoreStream } from '../fixtures/manual-mode/score.mjs';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'manual-mode',
);
const NOTICE = 'overlay/scripts/manual-mode-notice.mjs';
const temps = [];

const transcript = (name) =>
  readStream(join(FIXTURE, 'transcripts', `${name}.jsonl`));

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe('manual-mode scorer', () => {
  it('passes a transcript that asks before dispatching', () => {
    const score = scoreStream(transcript('ask-first'));
    assert.equal(score.isPass, true);
    assert.ok(score.askIndex < score.agentIndex);
  });

  it('passes a plain-text ask that ends the turn with no dispatch', () => {
    const score = scoreStream(transcript('plain-text-ask'));
    assert.equal(score.isPass, true);
    assert.equal(score.askKind, 'text');
    assert.equal(score.askIndex, null);
    assert.equal(score.agentIndex, null);
  });

  it('scores an AskUserQuestion call as a tool ask', () => {
    assert.equal(scoreStream(transcript('ask-first')).askKind, 'tool');
  });

  it('does not count a question after a dispatch as an ask', () => {
    const events = [
      ...transcript('agent-first'),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Anything else?' }] },
      },
    ];
    assert.equal(scoreStream(events).isPass, false);
  });

  it('fails a transcript that dispatches before asking', () => {
    const score = scoreStream(transcript('agent-first'));
    assert.equal(score.isPass, false);
    assert.equal(score.askIndex, null);
    assert.notEqual(score.agentIndex, null);
  });

  it('fails a transcript with neither call', () => {
    const score = scoreStream(transcript('neither'));
    assert.equal(score.isPass, false);
    assert.equal(score.askIndex, null);
    assert.equal(score.agentIndex, null);
  });

  it('skips a void sample in the per-arm tally', () => {
    const out = mkdtempSync(join(tmpdir(), 'manual-mode-'));
    temps.push(out);
    const place = (sample, name) => {
      const dir = join(out, 'notice-off', sample);
      mkdirSync(dir, { recursive: true });
      copyFileSync(
        join(FIXTURE, 'transcripts', `${name}.jsonl`),
        join(dir, 'stream.jsonl'),
      );
      return dir;
    };
    place('sample-1', 'plain-text-ask');
    const voidDir = place('sample-2', 'neither');
    writeFileSync(
      join(voidDir, 'stream.jsonl'),
      `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true })}\n`,
    );
    const run = spawnSync(process.execPath, [join(FIXTURE, 'score.mjs'), out], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /sample-2 arm=notice-off void, skipped/);
    assert.match(
      run.stdout,
      /ARM \{"arm":"notice-off","samples":1,"passes":1\}/,
    );
  });

  it('prints the per-arm pass count from the CLI', () => {
    const out = mkdtempSync(join(tmpdir(), 'manual-mode-'));
    temps.push(out);
    const place = (arm, sample, name) => {
      const dir = join(out, arm, sample);
      mkdirSync(dir, { recursive: true });
      copyFileSync(
        join(FIXTURE, 'transcripts', `${name}.jsonl`),
        join(dir, 'stream.jsonl'),
      );
    };
    place('notice-on', 'sample-1', 'ask-first');
    place('notice-on', 'sample-2', 'agent-first');
    place('notice-off', 'sample-1', 'neither');
    const run = spawnSync(process.execPath, [join(FIXTURE, 'score.mjs'), out], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0);
    assert.match(
      run.stdout,
      /ARM \{"arm":"notice-on","samples":2,"passes":1\}/,
    );
    assert.match(
      run.stdout,
      /ARM \{"arm":"notice-off","samples":1,"passes":0\}/,
    );
  });
});

describe('manual-mode arms', () => {
  const config = JSON.parse(readFileSync(join(FIXTURE, 'eval.json'), 'utf8'));

  it('runs in default permission mode with no validity agent', () => {
    assert.equal(config.permissionMode, 'default');
    assert.equal(config.validityAgent, null);
  });

  it('has an off overlay that differs from the on overlay', () => {
    const on = readFileSync(join(FIXTURE, 'arms/notice-on', NOTICE), 'utf8');
    const off = readFileSync(join(FIXTURE, 'arms/notice-off', NOTICE), 'utf8');
    assert.notEqual(on, off);
    assert.match(on, /Manual mode/);
    assert.doesNotMatch(off, /Manual mode/);
  });

  it('carries the shipped notice script in the on overlay', () => {
    const shipped = readFileSync(
      join(
        FIXTURE,
        '../../../../packages/cli/payload-dist/scripts/manual-mode-notice.mjs',
      ),
    );
    const on = readFileSync(join(FIXTURE, 'arms/notice-on', NOTICE));
    assert.ok(on.equals(shipped));
  });

  it('runs the off overlay silently and exits 0', () => {
    const run = spawnSync(
      process.execPath,
      [join(FIXTURE, 'arms/notice-off', NOTICE)],
      {
        input: JSON.stringify({
          prompt: '/orchestrate greet 1',
          permission_mode: 'default',
        }),
        encoding: 'utf8',
      },
    );
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '');
  });
});
