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

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const SCRIPT = '.claude/scripts/verify-changed.mjs';

// A dependency edge studio → cityville, committed so studio is a DEPENDENT of a
// cityville change (not itself changed). Returns after init with verify-changed on.
function fixtureWithDep() {
  const root = makeFixture('pnpm-monorepo');
  const studioPath = join(root, 'apps/studio/package.json');
  const studio = readJson(studioPath);
  studio.dependencies = { '@fix/cityville': 'workspace:*' };
  writeFileSync(studioPath, JSON.stringify(studio, null, 2));
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-qm', 'studio depends on cityville']);
  assert.equal(
    runCli(['init', '--yes', '--modules=verify-changed', root]).status,
    0,
  );
  return root;
}

function stubRunner(root, { fail = false } = {}) {
  const path = join(root, 'stub-runner.sh');
  writeFileSync(
    path,
    `#!/bin/sh\necho "$@" >> runner-calls.txt\n${fail ? 'echo "type error TS2322" >&2; exit 1' : 'exit 0'}\n`,
  );
  chmodSync(path, 0o755);
  const configPath = join(root, '.claude/kit.config.json');
  const config = readJson(configPath);
  config.verify.runner = './stub-runner.sh';
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

test('VC1: --json resolves changed package + its transitive DEPENDENT (reverse-dep)', () => {
  const root = fixtureWithDep();
  try {
    // Change only cityville source. studio depends on it → studio is a dependent.
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );
    const r = runScript(root, SCRIPT, { args: ['--json'] });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.degraded, false);
    const reason = Object.fromEntries(
      out.scope.map((s) => [s.package, s.reason]),
    );
    assert.equal(reason['@fix/cityville'], 'changed');
    assert.equal(reason['@fix/studio'], 'dependent', 'dependent pulled in');
    // Each scope entry carries the exact argv to run.
    const city = out.scope.find((s) => s.package === '@fix/cityville');
    assert.deepEqual(city.argv, [['--filter', '@fix/cityville', 'verify']]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('VC2: --run emits compact PASS/FAIL per package; failure → exit 2 + residue', () => {
  const root = fixtureWithDep();
  try {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );

    // Passing runner → both packages PASS, exit 0, one filtered call each.
    stubRunner(root, { fail: false });
    let r = runScript(root, SCRIPT, { args: ['--run'] });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /@fix\/cityville: PASS/);
    assert.match(r.stdout, /@fix\/studio: PASS/);
    const calls = readFileSync(join(root, 'runner-calls.txt'), 'utf8')
      .trim()
      .split('\n')
      .sort();
    assert.deepEqual(calls, [
      '--filter @fix/cityville verify',
      '--filter @fix/studio verify',
    ]);

    // Failing runner → FAIL + exit 2 + a trimmed residue tail on stderr.
    stubRunner(root, { fail: true });
    r = runScript(root, SCRIPT, { args: ['--run'] });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /@fix\/cityville: FAIL \(verify\)/);
    assert.match(r.stderr, /TS2322/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('VC3: --run degrades to exit 0 (never blocks) when git is unavailable', () => {
  const root = fixtureWithDep();
  try {
    // No changes at all → nothing to verify, exit 0 with a clear message.
    const r = runScript(root, SCRIPT, { args: ['--run'] });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing to verify/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('VC4: module install lands script + skill + verify config; doctor stays exit 0', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(
      runCli(['init', '--yes', '--modules=verify-changed', root]).status,
      0,
    );
    assert.ok(existsSync(join(root, SCRIPT)), 'helper script installed');
    assert.ok(
      existsSync(join(root, '.claude/skills/verify-changed/SKILL.md')),
      'skill installed',
    );
    const config = readJson(join(root, '.claude/kit.config.json'));
    assert.ok(config.verify, 'verify block present');
    assert.deepEqual(config.verify.commands, ['verify']);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    assert.ok(manifest.modules.includes('verify-changed'));
    const settings = readJson(join(root, '.claude/settings.json'));
    assert.ok(
      settings.permissions.allow.some((p) => p.includes('verify-changed.mjs')),
      'script permission wired',
    );
    assert.equal(runCli(['doctor', root]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('VC5: verify block absent unless the module is enabled', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    const config = readJson(join(root, '.claude/kit.config.json'));
    assert.equal(config.verify, undefined, 'no verify block by default');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RC1: reviewers module ships the /review-change dispatch skill', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(
      runCli(['init', '--yes', '--modules=reviewers', root]).status,
      0,
    );
    const skillPath = join(root, '.claude/skills/review-change/SKILL.md');
    assert.ok(existsSync(skillPath), '/review-change skill installed');
    const text = readFileSync(skillPath, 'utf8');
    assert.match(text, /pathPrefix/);
    assert.match(text, /OK.*Conflict.*Gap/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RDY1: ready module ships the /ready pre-handoff skill', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', '--modules=ready', root]).status, 0);
    const skillPath = join(root, '.claude/skills/ready/SKILL.md');
    assert.ok(existsSync(skillPath), '/ready skill installed');
    const text = readFileSync(skillPath, 'utf8');
    assert.match(text, /VERDICT/);
    assert.match(text, /acceptance checklist/i);
    assert.match(text, /backlog/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
