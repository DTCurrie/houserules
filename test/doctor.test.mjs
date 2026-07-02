import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli } from './fixtures.mjs';

test('DR1: healthy after init; missing file = ERROR; local edit / unwired hook / drift = WARN', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);

    let r = runCli(['doctor', root]);
    assert.equal(r.status, 0, `expected healthy, got:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /healthy/);

    // Local edit → WARN, still exit 0.
    const guard = join(root, '.claude/scripts/guard-bash.mjs');
    appendFileSync(guard, '// tweak\n');
    r = runCli(['doctor', root]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /locally edited: \.claude\/scripts\/guard-bash\.mjs/);

    // Missing kit file → ERROR, exit 1.
    const original = readFileSync(guard, 'utf8');
    rmSync(guard);
    r = runCli(['doctor', root]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /kit file missing/);
    writeFileSync(guard, original);

    // Unwired hook → WARN.
    const settingsPath = join(root, '.claude/settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    settings.hooks.SessionStart = [];
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    r = runCli(['doctor', root]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /session-context\.mjs not wired/);

    // Config drift: fix script renamed away in the package → WARN.
    const pkgPath = join(root, 'games/cityville/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    delete pkg.scripts.fix;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    r = runCli(['doctor', root]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /fix script "fix" not in games\/cityville\/package\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DR2: uninstalled repo → ERROR exit 1', () => {
  const root = makeFixture('non-js');
  try {
    const r = runCli(['doctor', root]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /kit not installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
