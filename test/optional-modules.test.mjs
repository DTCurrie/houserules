import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, runScript, sh } from './fixtures.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('OM1: ledger + reviewers + terse-style opt-ins land correctly', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const r = runCli(['init', '--yes', '--modules=ledger,reviewers,terse-style', root]);
    assert.equal(r.status, 0, r.stderr);

    // Ledger: script installed, config retargets to .claude/changelogs/ (never CHANGELOG.md).
    assert.ok(existsSync(join(root, '.claude/scripts/package-changelog.mjs')));
    const config = readJson(join(root, '.claude/kit.config.json'));
    assert.equal(config.ledger.enabled, true);
    const cityville = config.targets.find((t) => t.name === 'cityville');
    assert.equal(cityville.changelogPath, '.claude/changelogs/cityville.md');
    assert.equal(cityville.logPath, '.claude/changelogs/cityville.log');

    // Reviewers: DRAFT-marked seeds per target.
    for (const name of ['cityville-reviewer.md', 'studio-reviewer.md']) {
      const text = readFileSync(join(root, '.claude/agents', name), 'utf8');
      assert.match(text, /^description: "DRAFT/m, `${name} must be marked DRAFT`);
    }

    // Terse style: installed with attribution, not activated anywhere.
    const style = readFileSync(join(root, '.claude/output-styles/kit-terse.md'), 'utf8');
    assert.match(style, /caveman/i);
    assert.match(style, /MIT license/);
    const settings = readJson(join(root, '.claude/settings.json'));
    assert.equal(settings.outputStyle, undefined, 'kit must never set outputStyle');

    // Doctor flags the DRAFT reviewers but stays exit 0.
    const doc = runCli(['doctor', root]);
    assert.equal(doc.status, 0, doc.stdout);
    assert.match(doc.stdout, /DRAFT/);

    // Ledger integration: record HEAD into the retargeted changelog path.
    writeFileSync(join(root, 'games/cityville/src/extra.ts'), 'export const extra = 1;\n');
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'feat: cityville change']);
    const rec = runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['record', 'cityville', 'HEAD', '--changes', '- did a thing'],
    });
    assert.equal(rec.status, 0, rec.stderr);
    assert.ok(existsSync(join(root, '.claude/changelogs/cityville.md')));
    assert.ok(existsSync(join(root, '.claude/changelogs/cityville.log')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OM2: rename module gates on TypeScript', () => {
  const root = makeFixture('npm-single'); // no TS
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    assert.ok(!manifest.modules.includes('rename'));
    assert.ok(!existsSync(join(root, '.claude/scripts/rename.mjs')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
