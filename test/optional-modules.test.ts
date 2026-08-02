import { expect, test } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, runScript, sh } from './fixtures.js';

const readJson = (p: string): Record<string, any> =>
  JSON.parse(readFileSync(p, 'utf8'));

test('OM1: ledger + reviewers + terse-style opt-ins land correctly', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const r = runCli([
      'init',
      '--yes',
      '--modules=ledger,reviewers,terse-style',
      root,
    ]);
    expect(r.status, r.stderr).toBe(0);

    // Ledger: script installed, config retargets to .claude/changelogs/ (never CHANGELOG.md).
    expect(
      existsSync(join(root, '.claude/scripts/package-changelog.mjs')),
    ).toBeTruthy();
    // Ledger ships the archivist pattern it references.
    expect(
      existsSync(
        join(root, '.claude/kit-templates/agents/archivist.agent.md.template'),
      ),
    ).toBeTruthy();
    const config = readJson(join(root, '.claude/kit.config.json'));
    expect(config.ledger.enabled).toBe(true);
    const cityville = config.targets.find((t: any) => t.name === 'cityville');
    expect(cityville.changelogPath).toBe('.claude/changelogs/cityville.md');
    expect(cityville.logPath).toBe('.claude/changelogs/cityville.log');

    // Reviewers: DRAFT-marked seeds per target.
    for (const name of ['cityville-reviewer.md', 'studio-reviewer.md']) {
      const text = readFileSync(join(root, '.claude/agents', name), 'utf8');
      expect(text, `${name} must be marked DRAFT`).toMatch(
        /^description: "DRAFT/m,
      );
    }

    // Terse style: installed with attribution, not activated anywhere.
    const style = readFileSync(
      join(root, '.claude/output-styles/kit-terse.md'),
      'utf8',
    );
    expect(style).toMatch(/caveman/i);
    expect(style).toMatch(/MIT license/);
    const settings = readJson(join(root, '.claude/settings.json'));
    expect(settings.outputStyle, 'kit must never set outputStyle').toBe(
      undefined,
    );

    // Doctor flags the DRAFT reviewers but stays exit 0.
    const doc = runCli(['doctor', root]);
    expect(doc.status, doc.stdout).toBe(0);
    expect(doc.stdout).toMatch(/DRAFT/);

    // Ledger integration: record HEAD into the retargeted changelog path.
    writeFileSync(
      join(root, 'games/cityville/src/extra.ts'),
      'export const extra = 1;\n',
    );
    sh(root, 'git', ['add', '-A']);
    sh(root, 'git', ['commit', '-qm', 'feat: cityville change']);
    const rec = runScript(root, '.claude/scripts/package-changelog.mjs', {
      args: ['record', 'cityville', 'HEAD', '--changes', '- did a thing'],
    });
    expect(rec.status, rec.stderr).toBe(0);
    expect(
      existsSync(join(root, '.claude/changelogs/cityville.md')),
    ).toBeTruthy();
    expect(
      existsSync(join(root, '.claude/changelogs/cityville.log')),
    ).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OM2: rename module gates on TypeScript', () => {
  const root = makeFixture('npm-single'); // no TS
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(!manifest.modules.includes('rename')).toBeTruthy();
    expect(!existsSync(join(root, '.claude/scripts/rename.mjs'))).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OM3: debug-session lands the loop, self-gitignores logs, and the backstop hook reports orphans', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const r = runCli(['init', '--yes', '--modules=debug-session', root]);
    expect(r.status, r.stderr).toBe(0);

    // Skill, backstop hook, agent template, and the self-gitignored log dir all land.
    expect(
      existsSync(join(root, '.claude/skills/debug-session/SKILL.md')),
    ).toBeTruthy();
    expect(
      existsSync(join(root, '.claude/scripts/debug-session-check.mjs')),
    ).toBeTruthy();
    expect(
      existsSync(
        join(root, '.claude/kit-templates/agents/debugger.agent.md.template'),
      ),
    ).toBeTruthy();
    const ignore = readFileSync(join(root, '.claude/debug/.gitignore'), 'utf8');
    expect(ignore, 'logs ignored').toMatch(/^\*$/m);
    expect(ignore, 'the .gitignore stays tracked').toMatch(/^!\.gitignore$/m);

    // SessionStart hook wired, and doctor validates it (stays exit 0).
    const settings = readJson(join(root, '.claude/settings.json'));
    const cmds = (settings.hooks.SessionStart ?? []).flatMap((g: any) =>
      g.hooks.map((h: any) => h.command),
    );
    expect(
      cmds.some((c: string) => c.includes('debug-session-check.mjs')),
    ).toBeTruthy();
    expect(runCli(['doctor', root]).status).toBe(0);

    // Keep the exact tag out of this test's own source (a plain literal would make
    // `git grep CLAUDE-DEBUG` flag test/ in the kit's own repo).
    const MARKER = ['CLAUDE', 'DEBUG'].join('-');

    // Clean tree, no session log → the backstop says nothing.
    let hook = runScript(root, '.claude/scripts/debug-session-check.mjs');
    expect(hook.status).toBe(0);
    expect(hook.stdout.trim(), 'quiet when nothing is in flight').toBe('');

    // An open session log + tagged instrumentation in tracked source → both reported.
    writeFileSync(
      join(root, '.claude/debug/login-500.jsonl'),
      '{"hyp":"H1","at":"entry"}\n',
    );
    writeFileSync(
      join(root, 'games/cityville/src/game.ts'),
      `export const game = 1; // ${MARKER}\n`,
    );
    hook = runScript(root, '.claude/scripts/debug-session-check.mjs');
    expect(hook.status).toBe(0);
    expect(hook.stdout).toMatch(/open debug session/);
    expect(hook.stdout).toMatch(/login-500\.jsonl/);
    expect(hook.stdout).toMatch(/instrumentation/);
    expect(hook.stdout).toMatch(/game\.ts/);
    // The payload files carry the tag too, but they live under .claude/ (excluded),
    // so they never count as orphaned instrumentation.
    expect(!hook.stdout.includes('SKILL.md')).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OM4: debug-session is off by default and core does not stage its template', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(!manifest.modules.includes('debug-session')).toBeTruthy();

    // The always-staged reference templates land...
    expect(
      existsSync(
        join(root, '.claude/kit-templates/agents/reviewer.agent.md.template'),
      ),
    ).toBeTruthy();
    // ...but the debugger template ships only with its opt-in module (like archivist).
    expect(
      !existsSync(
        join(root, '.claude/kit-templates/agents/debugger.agent.md.template'),
      ),
    ).toBeTruthy();
    expect(
      !existsSync(join(root, '.claude/scripts/debug-session-check.mjs')),
    ).toBeTruthy();
    expect(
      !existsSync(join(root, '.claude/skills/debug-session/SKILL.md')),
    ).toBeTruthy();
    expect(!existsSync(join(root, '.claude/debug/.gitignore'))).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OM5: plans lands the /plan-project skill, self-gitignores the workspace, and wires the CLAUDE.md pointer', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const r = runCli(['init', '--yes', '--modules=plans', root]);
    expect(r.status, r.stderr).toBe(0);

    // Skill lands. The module is script-free and wires no hook.
    expect(
      existsSync(join(root, '.claude/skills/plan-project/SKILL.md')),
    ).toBeTruthy();
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(manifest.modules.includes('plans')).toBeTruthy();

    // The plan workspace is self-gitignored (repo .gitignore untouched), same as debug.
    const ignore = readFileSync(join(root, '.claude/plans/.gitignore'), 'utf8');
    expect(ignore, 'plan workspaces ignored').toMatch(/^\*$/m);
    expect(ignore, 'the .gitignore stays tracked').toMatch(/^!\.gitignore$/m);

    // The pull-only pointer lands in the seeded root CLAUDE.md (not a nested plans/CLAUDE.md,
    // which would never auto-load). It names /plan-project and the resume-by-ROADMAP discipline.
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd, 'CLAUDE.md points at the /plan-project skill').toMatch(
      /\/plan-project\b/,
    );
    expect(claudeMd).toMatch(/\.claude\/plans\//);
    expect(claudeMd, 'resume discipline is stated').toMatch(/ROADMAP/);
    expect(
      !existsSync(join(root, '.claude/plans/CLAUDE.md')),
      'no nested plans/CLAUDE.md (it would never load when needed)',
    ).toBeTruthy();

    // Doctor stays green (no hook to validate for this module).
    expect(runCli(['doctor', root]).status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OM6: plans is off by default — no skill, no workspace, no CLAUDE.md pointer', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(!manifest.modules.includes('plans')).toBeTruthy();

    expect(
      !existsSync(join(root, '.claude/skills/plan-project/SKILL.md')),
    ).toBeTruthy();
    expect(!existsSync(join(root, '.claude/plans/.gitignore'))).toBeTruthy();

    // The CLAUDE.md pointer is gated on the module. Absent when plans is off.
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(
      !claudeMd.includes('/plan-project'),
      'no /plan-project pointer without the module',
    ).toBeTruthy();
    expect(!claudeMd.includes('.claude/plans/')).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OM7: code-comments lands a PATH-SCOPED rule (no hook, no CLAUDE.md pointer)', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const r = runCli(['init', '--yes', '--modules=code-comments', root]);
    expect(r.status, r.stderr).toBe(0);

    const rulePath = join(root, '.claude/rules/code-comments.md');
    const text = readFileSync(rulePath, 'utf8');

    // The `paths:` frontmatter is what makes the rule conditional. Without it,
    // Claude Code loads .claude/rules/*.md on EVERY turn (resident context).
    expect(text, 'paths: frontmatter present').toMatch(
      /^---\n(?:.*\n)*?paths:\n/,
    );
    expect(text).toMatch(/^ {2}- ['"]\*\*\/\*\.ts['"]$/m);
    expect(text).toMatch(/Hard cap: 200 characters/);

    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(manifest.modules.includes('code-comments')).toBeTruthy();
    expect(
      manifest.files['.claude/rules/code-comments.md'],
      'the rule is kit-owned (update-refreshable)',
    ).toBeTruthy();

    // Script-free and hook-free: the platform does the conditional loading, and the
    // rule self-scopes, so nothing is added to the always-loaded surface.
    const settings = readJson(join(root, '.claude/settings.json'));
    const cmds = Object.values(settings.hooks ?? {}).flatMap((groups: any) =>
      groups.flatMap((g: any) => g.hooks.map((h: any) => h.command)),
    );
    expect(!cmds.some((c: string) => c.includes('code-comments'))).toBeTruthy();
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(
      !claudeMd.includes('code-comments'),
      'no CLAUDE.md pointer — paths: is the trigger',
    ).toBeTruthy();

    expect(runCli(['doctor', root]).status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OM8: code-comments is off by default', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(!manifest.modules.includes('code-comments')).toBeTruthy();
    expect(
      !existsSync(join(root, '.claude/rules/code-comments.md')),
    ).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OM9: prose-voice lands a PATH-SCOPED markdown rule, off by default', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(
      !existsSync(join(root, '.claude/rules/prose-voice.md')),
      'not installed until asked for',
    ).toBeTruthy();

    const r = runCli(['init', '--yes', '--modules=prose-voice', root]);
    expect(r.status, r.stderr).toBe(0);

    const text = readFileSync(
      join(root, '.claude/rules/prose-voice.md'),
      'utf8',
    );

    // Without `paths:` this rule would be resident on every turn. The dot-directory
    // globs are separate entries because `**` does not reliably descend into them.
    expect(text, 'paths: frontmatter present').toMatch(
      /^---\n(?:.*\n)*?paths:\n/,
    );
    expect(text).toMatch(/^ {2}- ['"]\*\*\/\*\.md['"]$/m);
    expect(text).toMatch(/^ {2}- ['"]\.changeset\/\*\.md['"]$/m);
    expect(text).toMatch(/No semicolons/);

    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(manifest.modules.includes('prose-voice')).toBeTruthy();
    expect(
      manifest.files['.claude/rules/prose-voice.md'],
      'the rule is kit-owned (update-refreshable)',
    ).toBeTruthy();

    // Same contract as code-comments: no hook, no CLAUDE.md pointer, `paths:` is the trigger.
    const settings = readJson(join(root, '.claude/settings.json'));
    const cmds = Object.values(settings.hooks ?? {}).flatMap((groups: any) =>
      groups.flatMap((g: any) => g.hooks.map((h: any) => h.command)),
    );
    expect(!cmds.some((c: string) => c.includes('prose-voice'))).toBeTruthy();
    expect(
      !readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('prose-voice'),
    ).toBeTruthy();

    expect(runCli(['doctor', root]).status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OM10: code-cleanliness lands a PATH-SCOPED rule plus a pull-only reference doc and the tidy skill', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const r = runCli(['init', '--yes', '--modules=code-cleanliness', root]);
    expect(r.status, r.stderr).toBe(0);

    const rulePath = join(root, '.claude/rules/code-cleanliness.md');
    const referencePath = join(root, '.claude/reference/design-principles.md');
    const skillPath = join(root, '.claude/skills/tidy/SKILL.md');

    expect(existsSync(rulePath)).toBeTruthy();
    expect(existsSync(referencePath)).toBeTruthy();
    expect(existsSync(skillPath)).toBeTruthy();

    const ruleText = readFileSync(rulePath, 'utf8');
    // The `paths:` frontmatter is what makes the rule conditional. Without it,
    // Claude Code loads .claude/rules/*.md on EVERY turn (resident context).
    expect(ruleText, 'paths: frontmatter present').toMatch(
      /^---\n(?:.*\n)*?paths:\n/,
    );
    expect(ruleText).toMatch(
      /Prefer intention-revealing names over short ones/,
    );

    const referenceText = readFileSync(referencePath, 'utf8');
    // Pull-only: no `paths:` key at all, and not under .claude/rules/.
    expect(referenceText, 'no paths: key in the reference doc').not.toMatch(
      /^paths:/m,
    );
    expect(
      existsSync(join(root, '.claude/rules/design-principles.md')),
      'reference doc must not live under .claude/rules/',
    ).toBeFalsy();
    expect(referenceText).toMatch(
      /Duplication is far cheaper than the wrong abstraction/,
    );

    const skillText = readFileSync(skillPath, 'utf8');
    expect(skillText).toMatch(/This is rule-driven, not judgment-driven/);

    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(manifest.modules.includes('code-cleanliness')).toBeTruthy();
    expect(
      manifest.files['.claude/rules/code-cleanliness.md'],
      'the rule is kit-owned (update-refreshable)',
    ).toBeTruthy();
    expect(
      manifest.files['.claude/reference/design-principles.md'],
      'the reference doc is kit-owned (update-refreshable)',
    ).toBeTruthy();
    expect(
      manifest.files['.claude/skills/tidy/SKILL.md'],
      'the skill is kit-owned (update-refreshable)',
    ).toBeTruthy();

    // Script-free and hook-free: nothing is added to the always-loaded surface.
    const settings = readJson(join(root, '.claude/settings.json'));
    const cmds = Object.values(settings.hooks ?? {}).flatMap((groups: any) =>
      groups.flatMap((g: any) => g.hooks.map((h: any) => h.command)),
    );
    expect(
      !cmds.some((c: string) => c.includes('code-cleanliness')),
    ).toBeTruthy();
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(
      !claudeMd.includes('code-cleanliness'),
      'no CLAUDE.md pointer — paths: is the trigger',
    ).toBeTruthy();

    expect(runCli(['doctor', root]).status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OM11: code-cleanliness is off by default', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(!manifest.modules.includes('code-cleanliness')).toBeTruthy();
    expect(
      !existsSync(join(root, '.claude/rules/code-cleanliness.md')),
    ).toBeTruthy();
    expect(
      !existsSync(join(root, '.claude/reference/design-principles.md')),
    ).toBeTruthy();
    expect(
      !existsSync(join(root, '.claude/skills/tidy/SKILL.md')),
    ).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
