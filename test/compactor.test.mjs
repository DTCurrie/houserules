import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, runScript } from './fixtures.mjs';

const SCRIPT = '.claude/scripts/compact-tool-output.mjs';

function installedWithCompactor() {
  const root = makeFixture('pnpm-monorepo');
  assert.equal(runCli(['init', '--yes', '--modules=output-compactor', root]).status, 0);
  return root;
}

test('CP1: oversized Bash output → updatedToolOutput JSON + spill file + self-gitignore', () => {
  const root = installedWithCompactor();
  try {
    const big = Array.from({ length: 900 }, (_, i) => `line ${i}: ${'x'.repeat(20)}`).join('\n');
    assert.ok(big.length > 10000);
    const r = runScript(root, SCRIPT, {
      input: JSON.stringify({ tool_name: 'Bash', tool_response: { stdout: big, stderr: '' } }),
    });
    assert.equal(r.status, 0, r.stderr);

    const out = JSON.parse(r.stdout);
    const updated = out.hookSpecificOutput.updatedToolOutput;
    assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(updated.startsWith('line 0:'), 'head preserved');
    assert.match(updated, /lines omitted — full output saved to \.claude\/tool-output\//);
    assert.ok(updated.includes('line 899:'), 'tail preserved');
    assert.ok(updated.length < big.length / 5, 'meaningfully compacted');

    const spillDir = join(root, '.claude/tool-output');
    const spills = readdirSync(spillDir).filter((f) => f.startsWith('bash-'));
    assert.equal(spills.length, 1);
    assert.equal(readFileSync(join(spillDir, spills[0]), 'utf8'), big, 'full output recoverable');
    assert.equal(readFileSync(join(spillDir, '.gitignore'), 'utf8'), '*\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CP2: small output, non-Bash tools, and garbage stdin are all silent no-ops', () => {
  const root = installedWithCompactor();
  try {
    let r = runScript(root, SCRIPT, {
      input: JSON.stringify({ tool_name: 'Bash', tool_response: { stdout: 'short' } }),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');

    r = runScript(root, SCRIPT, {
      input: JSON.stringify({ tool_name: 'Read', tool_response: 'x'.repeat(20000) }),
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');

    r = runScript(root, SCRIPT, { input: '≈≈ definitely not json ≈≈' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
