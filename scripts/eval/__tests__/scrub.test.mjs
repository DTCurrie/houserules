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
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scrub.mjs', import.meta.url));
const KEY = 'sk-test-0123456789';
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function scrub(dir, key) {
  return spawnSync(process.execPath, [SCRIPT, dir], {
    encoding: 'utf8',
    env: { ...process.env, EVAL_SCRUB_KEY: key },
  });
}

describe('scrub', () => {
  test('replaces the key at any depth, leaves clean files alone, prints the count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrub-'));
    temps.push(dir);
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    writeFileSync(join(dir, 'top.txt'), `x ${KEY} y ${KEY}\n`);
    writeFileSync(join(dir, 'a', 'b', 'deep.jsonl'), `{"k":"${KEY}"}\n`);
    const clean = Buffer.from([0, 255, 1, 2, 10, 200]);
    writeFileSync(join(dir, 'a', 'clean.bin'), clean);

    const result = scrub(dir, KEY);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '2\n');
    assert.equal(
      readFileSync(join(dir, 'top.txt'), 'utf8'),
      'x [REDACTED] y [REDACTED]\n',
    );
    assert.equal(
      readFileSync(join(dir, 'a', 'b', 'deep.jsonl'), 'utf8'),
      '{"k":"[REDACTED]"}\n',
    );
    assert.deepEqual(readFileSync(join(dir, 'a', 'clean.bin')), clean);
    assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY));
  });

  test('an empty or unset key exits 2', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scrub-'));
    temps.push(dir);
    assert.equal(scrub(dir, '').status, 2);
    const env = { ...process.env };
    delete env.EVAL_SCRUB_KEY;
    const unset = spawnSync(process.execPath, [SCRIPT, dir], {
      encoding: 'utf8',
      env,
    });
    assert.equal(unset.status, 2);
  });
});
