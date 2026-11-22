import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { FIXTURE_TOKEN } from '../layout.mjs';
import {
  judgeProbeA,
  judgeProbeB,
  manifestHashes,
  pathWithoutHouserules,
  priceTranscripts,
} from '../preflight.mjs';

const dirs = [];
function temp() {
  const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function assistant(id, model, usage) {
  return JSON.stringify({ type: 'assistant', message: { id, model, usage } });
}

describe('preflight priceTranscripts', () => {
  it('prices a duplicated message id once and counts a nested subagent file', () => {
    const dir = temp();
    mkdirSync(join(dir, 'sess', 'subagents'), { recursive: true });
    const usage = { input_tokens: 1_000_000, output_tokens: 0 };
    writeFileSync(
      join(dir, 'main.jsonl'),
      [
        assistant('m1', 'claude-haiku-4-5', usage),
        assistant('m1', 'claude-haiku-4-5', usage),
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'sess', 'subagents', 'agent-1.jsonl'),
      `${assistant('m2', 'claude-haiku-4-5', { input_tokens: 0, output_tokens: 1_000_000 })}\n`,
    );
    assert.ok(Math.abs(priceTranscripts(dir) - 6) < 1e-9);
  });

  it('prices cache reads and 5-minute and 1-hour cache writes', () => {
    const dir = temp();
    writeFileSync(
      join(dir, 'a.jsonl'),
      `${assistant('m1', 'claude-haiku-4-5', {
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_000_000,
        cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
      })}\n`,
    );
    // read 0.1 + 5m 1.25 + 1h 2 = 3.35 at $1 input
    assert.ok(Math.abs(priceTranscripts(dir) - 3.35) < 1e-9);
  });

  it('throws naming a model with no price row', () => {
    const dir = temp();
    writeFileSync(
      join(dir, 'a.jsonl'),
      `${assistant('m1', 'claude-mystery-9', { input_tokens: 5 })}\n`,
    );
    assert.throws(() => priceTranscripts(dir), /claude-mystery-9/);
  });
});

describe('preflight judgeProbeB', () => {
  const margin = (total) =>
    judgeProbeB({ resultEvent: { total_cost_usd: total }, pricedUsd: total })
      .margin;

  it('derives the margin rounded up to a tenth, at least 0.1', () => {
    assert.equal(margin(0.021), 0.1);
    assert.equal(margin(0.024), 0.2);
    assert.equal(margin(0.0241), 0.3);
    assert.equal(margin(0.019), 0.1);
  });

  it('matches the ratio from 0.90 to 1.25 inclusive', () => {
    const ratio = (total) =>
      judgeProbeB({ resultEvent: { total_cost_usd: total }, pricedUsd: 1 });
    assert.equal(ratio(0.89).isMatch, false);
    assert.equal(ratio(0.9).isMatch, true);
    assert.equal(ratio(1.25).isMatch, true);
    assert.equal(ratio(1.26).isMatch, false);
  });

  it('passes on the cap or a budget stop, plus a match, and not otherwise', () => {
    const cap = judgeProbeB({
      resultEvent: { total_cost_usd: 0.03 },
      pricedUsd: 0.03,
    });
    assert.equal(cap.pass, true);
    assert.equal(cap.hasReachedCap, true);
    const stop = judgeProbeB({
      resultEvent: { total_cost_usd: 0.019, subtype: 'error_max_budget_usd' },
      pricedUsd: 0.019,
    });
    assert.equal(stop.pass, true);
    assert.equal(stop.isBudgetStop, true);
    const under = judgeProbeB({
      resultEvent: { total_cost_usd: 0.002, subtype: 'success' },
      pricedUsd: 0.002,
    });
    assert.equal(under.pass, false);
    const mismatch = judgeProbeB({
      resultEvent: { total_cost_usd: 0.03 },
      pricedUsd: 0.1,
    });
    assert.equal(mismatch.pass, false);
    assert.equal(judgeProbeB({ resultEvent: null, pricedUsd: 1 }).pass, false);
  });
});

describe('preflight judgeProbeA', () => {
  const before = { 'a.mjs': 'h1', 'b.mjs': 'h2' };
  const quoting = { result: `The token is ${FIXTURE_TOKEN}.` };

  it('passes when the token is quoted and no file changed', () => {
    const verdict = judgeProbeA({
      resultEvent: quoting,
      before,
      after: { ...before },
    });
    assert.deepEqual(verdict, {
      pass: true,
      isQuoted: true,
      fileCount: 2,
      rewritten: [],
    });
  });

  it('fails on a missing token', () => {
    const verdict = judgeProbeA({
      resultEvent: { result: 'no idea' },
      before,
      after: { ...before },
    });
    assert.equal(verdict.pass, false);
    assert.equal(verdict.isQuoted, false);
  });

  it('fails on one rewritten or vanished file', () => {
    const rewritten = judgeProbeA({
      resultEvent: quoting,
      before,
      after: { ...before, 'b.mjs': 'changed' },
    });
    assert.equal(rewritten.pass, false);
    assert.deepEqual(rewritten.rewritten, ['b.mjs']);
    const vanished = judgeProbeA({
      resultEvent: quoting,
      before,
      after: { 'a.mjs': 'h1' },
    });
    assert.deepEqual(vanished.rewritten, ['b.mjs']);
  });

  it('fails when no manifest file was hashed', () => {
    assert.equal(
      judgeProbeA({ resultEvent: quoting, before: {}, after: {} }).pass,
      false,
    );
  });
});

describe('preflight manifestHashes', () => {
  it('hashes each listed file and marks a missing one', () => {
    const root = temp();
    mkdirSync(join(root, '.claude'));
    writeFileSync(join(root, 'x.txt'), 'abc');
    writeFileSync(
      join(root, '.claude', 'houserules.manifest.json'),
      JSON.stringify({ files: { 'x.txt': 'ignored', 'gone.txt': 'ignored' } }),
    );
    assert.deepEqual(manifestHashes(root), {
      'x.txt':
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      'gone.txt': 'missing',
    });
  });
});

describe('preflight pathWithoutHouserules', () => {
  it('drops a directory holding an executable houserules and keeps the rest in order', () => {
    const withBin = temp();
    const keepA = temp();
    const keepB = temp();
    writeFileSync(join(withBin, 'houserules'), '#!/bin/sh\n');
    chmodSync(join(withBin, 'houserules'), 0o755);
    const result = pathWithoutHouserules(
      [keepA, withBin, keepB, '/definitely/not/here'].join(delimiter),
    );
    assert.equal(
      result,
      [keepA, keepB, '/definitely/not/here'].join(delimiter),
    );
  });
});
