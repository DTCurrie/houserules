import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, runScript, sh } from './fixtures.mjs';

const SCRIPT = '.claude/scripts/lint-format-fix.mjs';

function stubRunner(root, { fail = false } = {}) {
  const path = join(root, 'stub-runner.sh');
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" >> runner-calls.txt\n${fail ? 'echo "1 unfixable problem" >&2; exit 1' : 'exit 0'}\n`,
  );
  chmodSync(path, 0o755);
}

function setRunner(root, fixOverrides = {}) {
  const configPath = join(root, '.claude/kit.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.fix = {
    runner: './stub-runner.sh',
    filterFlag: '--filter',
    runScriptPrefix: ['run'],
    commands: ['lint:fix', 'format:fix'],
    ...fixOverrides,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

test('L1: changed package → runner invoked with --filter <pkg> fix (per-target override)', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    stubRunner(root);
    setRunner(root);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );

    const r = runScript(root, SCRIPT, { input: '{}' });
    assert.equal(r.status, 0, r.stderr);
    const calls = readFileSync(join(root, 'runner-calls.txt'), 'utf8')
      .trim()
      .split('\n');
    // fixCommands ["fix"] from detection overrides global commands — exactly one call.
    assert.deepEqual(calls, ['--filter @fix/cityville fix']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('L2: failing fix → exit 2 with residue tail; stop_hook_active short-circuits', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    stubRunner(root, { fail: true });
    setRunner(root);
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const y = 9;\n',
    );

    let r = runScript(root, SCRIPT, { input: '{}' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /residual issues/);
    assert.match(r.stderr, /unfixable problem/);

    r = runScript(root, SCRIPT, { input: '{"stop_hook_active":true}' });
    assert.equal(r.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('L3: single-package (no filter flag) uses run-prefix form; generated files ignored', () => {
  const root = makeFixture('npm-single');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    stubRunner(root);
    setRunner(root, { filterFlag: '' });
    appendFileSync(join(root, 'src/index.js'), 'exports.more = 1;\n');

    let r = runScript(root, SCRIPT, { input: '{}' });
    assert.equal(r.status, 0, r.stderr);
    const calls = readFileSync(join(root, 'runner-calls.txt'), 'utf8')
      .trim()
      .split('\n');
    assert.deepEqual(calls, ['run lint:fix']); // detected fixCommands ["lint:fix"]

    // Only a generated ledger file changed → no runner calls.
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'wip']);
    rmSync(join(root, 'runner-calls.txt'));
    writeFileSync(join(root, 'BACKLOG.md'), '# Backlog\n');
    r = runScript(root, SCRIPT, { input: '{}' });
    assert.equal(r.status, 0);
    assert.ok(
      !existsSync(join(root, 'runner-calls.txt')),
      'generated-only change ran the fixer',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
