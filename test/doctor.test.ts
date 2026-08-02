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

    // A local edit is reported as `yours` with a diff and still exits 0. Nothing lets you
    // acknowledge it, so failing would leave doctor permanently red on a healthy install.
    const guard = join(root, '.claude/scripts/guard-bash.mjs');
    appendFileSync(guard, '// tweak\n');
    r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/\.claude\/scripts\/guard-bash\.mjs: yours/);
    // `-` is what is on disk, `+` is what the kit would write. So the line YOU
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
    // never summed into the resident total. Root stays under budget despite it.
    writeFileSync(join(root, 'games/cityville/CLAUDE.md'), 'x\n'.repeat(400));
    r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/resident context.*headroom/); // still under budget
    expect(r.stdout).toMatch(/nested.*games\/cityville\/CLAUDE\.md/);
    expect(r.stdout).not.toMatch(/always-loaded context exceeds budget/);

    // Append rather than overwrite. Clobbering the file would also delete the kit's
    // managed markers, which is a separate drift finding and not what this test is about.
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

    // .claude/CLAUDE.md is project memory too (summed, not ignored).
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

test('DR4c: skill/agent description frontmatter is a distinct resident line, strictly larger than without', () => {
  const withSkills = makeFixture('pnpm-monorepo');
  const withoutSkills = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', withSkills]).status).toBe(0);
    expect(
      runCli([
        'init',
        '--yes',
        '--modules=-backlog,-changesets,-reviewers',
        withoutSkills,
      ]).status,
    ).toBe(0);

    const withR = runCli(['doctor', withSkills]);
    expect(withR.status, withR.stdout).toBe(0);
    const lineRe =
      /resident skill\/agent descriptions \((\d+) skill\(s\) \+ (\d+) agent\(s\)\): ~(\d+) tokens/;
    const withMatch = lineRe.exec(withR.stdout);
    expect(withMatch, withR.stdout).not.toBeNull();
    const withSkillCount = Number(withMatch![1]);
    const withAgentCount = Number(withMatch![2]);
    const withTokens = Number(withMatch![3]);
    expect(withSkillCount + withAgentCount).toBeGreaterThan(0);
    expect(withTokens).toBeGreaterThan(0);

    const withoutR = runCli(['doctor', withoutSkills]);
    expect(withoutR.status, withoutR.stdout).toBe(0);
    // No skills/agents installed → the line item does not appear at all, and it is
    // never silently folded into the `resident context (...)` readout.
    expect(withoutR.stdout).not.toMatch(/resident skill\/agent descriptions/);
    expect(withoutR.stdout).toMatch(/resident context \(CLAUDE\.md\)/);

    // Combined resident total (CLAUDE.md/rules + skill/agent descriptions) is
    // strictly larger with skills/agents installed than without.
    const claudeMdOnly = Number(
      /resident context \(CLAUDE\.md\): ~(\d+) tokens/.exec(
        withoutR.stdout,
      )![1],
    );
    const claudeMdWithSkills = Number(
      /resident context \(CLAUDE\.md\): ~(\d+) tokens/.exec(withR.stdout)![1],
    );
    expect(claudeMdWithSkills + withTokens).toBeGreaterThan(claudeMdOnly);
  } finally {
    rmSync(withSkills, { recursive: true, force: true });
    rmSync(withoutSkills, { recursive: true, force: true });
  }
});

test('DR4d: skill/agent BODY is excluded — only description frontmatter counts', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    const lineRe =
      /resident skill\/agent descriptions \(\d+ skill\(s\) \+ \d+ agent\(s\)\): ~(\d+) tokens/;
    let r = runCli(['doctor', root]);
    const before = Number(lineRe.exec(r.stdout)![1]);

    // A huge skill BODY (not its description) barely moves the total. Bodies load
    // only on invocation, the on-demand tier, not on every turn.
    appendFileSync(
      join(root, '.claude/skills/backlog-add/SKILL.md'),
      `\n${'x '.repeat(3000)}`,
    );
    r = runCli(['doctor', root]);
    const after = Number(lineRe.exec(r.stdout)![1]);
    expect(after).toBe(before);
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

    // Add a package after init (apps/* is a workspace glob). Silently uncovered.
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
    // Enable terse-style for real. Hand-editing the manifest would claim the module is
    // installed while its files are not, which the drift engine reports as broken.
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

test('DR4: committed .claude/scripts → WARN (exit 0) with the untrack fix', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    // Fresh install: scripts are gitignored, so doctor stays clean.
    let r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/script\(s\).*are committed/);

    // Commit them (pre-gitignore install shape) → WARN, still exit 0.
    sh(root, 'git', ['add', '-f', '.claude/scripts']);
    sh(root, 'git', ['commit', '-qm', 'committed scripts']);
    r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toMatch(/script\(s\).*are committed/);
    expect(r.stdout).toMatch(/git rm --cached/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DR5: scripts.commit: true suppresses the committed-scripts finding', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const configPath = join(root, '.claude/kit.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.scripts = { commit: true };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'opt-in commit + config change']);

    // Reconcile the now-orphaned .gitignore (kit-owned, unmodified) before asserting
    // doctor is clean. Flipping the switch after install leaves it stale for one run.
    expect(runCli(['update', root]).status).toBe(0);

    const r = runCli(['doctor', root]);
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toMatch(/script\(s\).*are committed/);
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
