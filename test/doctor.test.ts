import { expect, test } from 'vitest';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, sh } from './fixtures.js';

test('DR1: healthy after init; missing file = ERROR; local edit / unwired hook / drift = WARN', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    let r = runCli(['doctor', root]);
    expect(r.status, `expected healthy, got:\n${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/healthy/);

    // Local edit → reported as `yours` with a diff, and still exit 0: an edit you
    // made on purpose is not a defect, and nothing lets you acknowledge it, so
    // failing on it would leave doctor permanently red on a healthy install.
    const guard = join(root, '.claude/scripts/guard-bash.mjs');
    appendFileSync(guard, '// tweak\n');
    r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/\.claude\/scripts\/guard-bash\.mjs: yours/);
    // `-` is what is on disk, `+` is what the kit would write — so the line YOU
    // added shows as a `-` (what --force would remove).
    expect(r.stdout, 'drift is reported with a diff').toMatch(/-\/\/ tweak/);

    // Missing kit file → ERROR, exit 1.
    const original = readFileSync(guard, 'utf8');
    rmSync(guard);
    r = runCli(['doctor', root]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/\.claude\/scripts\/guard-bash\.mjs: missing/);
    writeFileSync(guard, original);

    // Unwired hook → WARN.
    const settingsPath = join(root, '.claude/settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    settings.hooks.SessionStart = [];
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    r = runCli(['doctor', root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/session-context\.mjs not wired/);

    // Config drift: fix script renamed away in the package → WARN.
    const pkgPath = join(root, 'games/cityville/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      scripts: Record<string, unknown>;
    };
    delete pkg.scripts.fix;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    r = runCli(['doctor', root]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(
      /fix script "fix" not in games\/cityville\/package\.json/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DR4: resident-surface budget — headroom vs OVER; nested CLAUDE.md listed separately, never summed', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    // Seeded root CLAUDE.md is under budget → readout shows headroom, exit 0.
    let r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/resident context.*headroom/);
    expect(r.stdout).not.toMatch(/always-loaded context exceeds budget/);

    // A huge NESTED package CLAUDE.md is the on-demand tier: listed separately,
    // never summed into the resident total — root stays under budget despite it.
    writeFileSync(join(root, 'games/cityville/CLAUDE.md'), 'x\n'.repeat(400));
    r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/resident context.*headroom/); // still under budget
    expect(r.stdout).toMatch(/nested.*games\/cityville\/CLAUDE\.md/);
    expect(r.stdout).not.toMatch(/always-loaded context exceeds budget/);

    // Root CLAUDE.md over the line budget → readout OVER + a WARN, still exit 0.
    // Append rather than overwrite: clobbering the file would also delete the kit's
    // managed markers, which is a separate (real) drift finding and not what this
    // test is about.
    appendFileSync(join(root, 'CLAUDE.md'), '# big\n'.repeat(250));
    r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/resident context.*OVER/);
    expect(r.stdout).toMatch(/always-loaded context exceeds budget/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DR4b: resident surface counts .claude/CLAUDE.md + globless rules; path-scoped rules are free', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(
      runCli(['init', '--yes', '--modules=code-comments', root]).status,
    ).toBe(0);

    // The shipped rule is path-scoped → conditional, so it is NOT resident.
    let r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/resident context.*code-comments/);
    expect(r.stdout).not.toMatch(/loaded on EVERY turn/);

    // A rule with no `paths:` frontmatter IS resident: named in the readout + WARNed.
    writeFileSync(
      join(root, '.claude/rules/always.md'),
      '---\ndescription: "no globs"\n---\n\n# Always\n',
    );
    r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /resident context \(CLAUDE\.md \+ \.claude\/rules\/always\.md\)/,
    );
    expect(r.stdout).toMatch(/loaded on EVERY turn.*always\.md/);

    // .claude/CLAUDE.md is project memory too — summed, not ignored.
    writeFileSync(join(root, '.claude/CLAUDE.md'), '# big\n'.repeat(250));
    r = runCli(['doctor', root]);
    expect(r.stdout).toMatch(
      /resident context \(CLAUDE\.md \+ \.claude\/CLAUDE\.md/,
    );
    expect(r.stdout).toMatch(/resident context.*OVER/);
    expect(r.stdout).toMatch(/always-loaded context exceeds budget/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DR5: workspace package with no kit target → WARN pointing at kit.config.json (exit 0)', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    // Healthy: init gave every workspace member a target.
    let r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/has no kit target/);

    // Add a package after init (apps/* is a workspace glob) — silently uncovered.
    mkdirSync(join(root, 'apps/newgame'), { recursive: true });
    writeFileSync(
      join(root, 'apps/newgame/package.json'),
      JSON.stringify({ name: '@fix/newgame', private: true }, null, 2),
    );
    r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(
      /workspace package "@fix\/newgame" \(apps\/newgame\) has no kit target/,
    );
    expect(r.stdout).toMatch(/kit\.config\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DR6: terse-style ACTIVE / INACTIVE / mis-slugged fallback from the real outputStyle', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    // Enable terse-style for real (default-off otherwise). Hand-editing the manifest
    // instead would claim the module is installed while its files are not, which the
    // drift engine now correctly reports as a broken install.
    expect(
      runCli(['modules', root, '--yes', '--modules', 'terse-style']).status,
    ).toBe(0);

    const localPath = join(root, '.claude/settings.local.json');
    const setStyle = (v: string | undefined) => {
      const local = JSON.parse(readFileSync(localPath, 'utf8')) as {
        outputStyle?: string;
      };
      if (v === undefined) delete local.outputStyle;
      else local.outputStyle = v;
      writeFileSync(localPath, JSON.stringify(local, null, 2));
    };

    // Installed, no outputStyle → INACTIVE.
    let r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/terse-style: INACTIVE/);

    // Correct frontmatter name → ACTIVE.
    setStyle('Kit Terse');
    r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/terse-style: ACTIVE/);

    // The filename slug silently falls back to Default → WARN with the exact fix.
    setStyle('kit-terse');
    r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/"kit-terse".*falls back to Default/);
    expect(r.stdout).toMatch(/"Kit Terse"/);

    // A different style selected → INACTIVE (installed but not the active style).
    setStyle('Explanatory');
    r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/terse-style: INACTIVE.*Explanatory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DR2: uninstalled repo → ERROR exit 1', () => {
  const root = makeFixture('non-js');
  try {
    const r = runCli(['doctor', root]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/kit not installed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DR3: committed reference templates → WARN (exit 0) with the untrack fix', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    // Fresh install: templates are gitignored, so doctor stays clean.
    let r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/reference template/);

    // Commit the templates (pre-gitignore install shape) → WARN, still exit 0.
    sh(root, 'git', ['add', '-f', '.claude/kit-templates']);
    sh(root, 'git', ['commit', '-qm', 'committed templates']);
    r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/reference template\(s\).*are committed/);
    expect(r.stdout).toMatch(/git rm --cached/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
