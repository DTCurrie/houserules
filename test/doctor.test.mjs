import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, sh } from './fixtures.mjs';

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
    assert.match(
      r.stdout,
      /locally edited: \.claude\/scripts\/guard-bash\.mjs/,
    );

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
    assert.match(
      r.stdout,
      /fix script "fix" not in games\/cityville\/package\.json/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DR4: resident-surface budget — headroom vs OVER; nested CLAUDE.md listed separately, never summed', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);

    // Seeded root CLAUDE.md is under budget → readout shows headroom, exit 0.
    let r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /resident context.*headroom/);
    assert.doesNotMatch(r.stdout, /always-loaded context exceeds budget/);

    // A huge NESTED package CLAUDE.md is the on-demand tier: listed separately,
    // never summed into the resident total — root stays under budget despite it.
    writeFileSync(join(root, 'games/cityville/CLAUDE.md'), 'x\n'.repeat(400));
    r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /resident context.*headroom/); // still under budget
    assert.match(r.stdout, /nested.*games\/cityville\/CLAUDE\.md/);
    assert.doesNotMatch(r.stdout, /always-loaded context exceeds budget/);

    // Root CLAUDE.md over the line budget → readout OVER + a WARN, still exit 0.
    writeFileSync(join(root, 'CLAUDE.md'), '# big\n'.repeat(250));
    r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /resident context.*OVER/);
    assert.match(r.stdout, /always-loaded context exceeds budget/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DR5: workspace package with no kit target → WARN pointing at kit.config.json (exit 0)', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    // Healthy: init gave every workspace member a target.
    let r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /has no kit target/);

    // Add a package after init (apps/* is a workspace glob) — silently uncovered.
    mkdirSync(join(root, 'apps/newgame'), { recursive: true });
    writeFileSync(
      join(root, 'apps/newgame/package.json'),
      JSON.stringify({ name: '@fix/newgame', private: true }, null, 2),
    );
    r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(
      r.stdout,
      /workspace package "@fix\/newgame" \(apps\/newgame\) has no kit target/,
    );
    assert.match(r.stdout, /kit\.config\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DR6: terse-style ACTIVE / INACTIVE / mis-slugged fallback from the real outputStyle', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    // Enable the terse-style module in the manifest (default-off otherwise).
    const manifestPath = join(root, '.claude/kit-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.modules = [...manifest.modules, 'terse-style'];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const localPath = join(root, '.claude/settings.local.json');
    const setStyle = (v) => {
      const local = JSON.parse(readFileSync(localPath, 'utf8'));
      if (v === undefined) delete local.outputStyle;
      else local.outputStyle = v;
      writeFileSync(localPath, JSON.stringify(local, null, 2));
    };

    // Installed, no outputStyle → INACTIVE.
    let r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /terse-style: INACTIVE/);

    // Correct frontmatter name → ACTIVE.
    setStyle('Kit Terse');
    r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /terse-style: ACTIVE/);

    // The filename slug silently falls back to Default → WARN with the exact fix.
    setStyle('kit-terse');
    r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /"kit-terse".*falls back to Default/);
    assert.match(r.stdout, /"Kit Terse"/);

    // A different style selected → INACTIVE (installed but not the active style).
    setStyle('Explanatory');
    r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /terse-style: INACTIVE.*Explanatory/);
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

test('DR3: committed reference templates → WARN (exit 0) with the untrack fix', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    // Fresh install: templates are gitignored, so doctor stays clean.
    let r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /reference template/);

    // Commit the templates (pre-gitignore install shape) → WARN, still exit 0.
    sh(root, 'git', ['add', '-f', '.claude/kit-templates']);
    sh(root, 'git', ['commit', '-qm', 'committed templates']);
    r = runCli(['doctor', root]);
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /reference template\(s\).*are committed/);
    assert.match(r.stdout, /git rm --cached/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
