import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli, runScript, sh } from './fixtures.mjs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

test('OM1: ledger + reviewers + terse-style opt-ins land correctly', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const r = runCli([
      'init',
      '--yes',
      '--modules=ledger,reviewers,terse-style',
      root,
    ]);
    assert.equal(r.status, 0, r.stderr);

    // Ledger: script installed, config retargets to .claude/changelogs/ (never CHANGELOG.md).
    assert.ok(existsSync(join(root, '.claude/scripts/package-changelog.mjs')));
    // Ledger ships the archivist pattern it references.
    assert.ok(
      existsSync(
        join(root, '.claude/kit-templates/agents/archivist.agent.md.template'),
      ),
    );
    const config = readJson(join(root, '.claude/kit.config.json'));
    assert.equal(config.ledger.enabled, true);
    const cityville = config.targets.find((t) => t.name === 'cityville');
    assert.equal(cityville.changelogPath, '.claude/changelogs/cityville.md');
    assert.equal(cityville.logPath, '.claude/changelogs/cityville.log');

    // Reviewers: DRAFT-marked seeds per target.
    for (const name of ['cityville-reviewer.md', 'studio-reviewer.md']) {
      const text = readFileSync(join(root, '.claude/agents', name), 'utf8');
      assert.match(
        text,
        /^description: "DRAFT/m,
        `${name} must be marked DRAFT`,
      );
    }

    // Terse style: installed with attribution, not activated anywhere.
    const style = readFileSync(
      join(root, '.claude/output-styles/kit-terse.md'),
      'utf8',
    );
    assert.match(style, /caveman/i);
    assert.match(style, /MIT license/);
    const settings = readJson(join(root, '.claude/settings.json'));
    assert.equal(
      settings.outputStyle,
      undefined,
      'kit must never set outputStyle',
    );

    // Doctor flags the DRAFT reviewers but stays exit 0.
    const doc = runCli(['doctor', root]);
    assert.equal(doc.status, 0, doc.stdout);
    assert.match(doc.stdout, /DRAFT/);

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

test('OM3: debug-session lands the loop, self-gitignores logs, and the backstop hook reports orphans', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    const r = runCli(['init', '--yes', '--modules=debug-session', root]);
    assert.equal(r.status, 0, r.stderr);

    // Skill, backstop hook, agent template, and the self-gitignored log dir all land.
    assert.ok(existsSync(join(root, '.claude/skills/debug-session/SKILL.md')));
    assert.ok(
      existsSync(join(root, '.claude/scripts/debug-session-check.mjs')),
    );
    assert.ok(
      existsSync(
        join(root, '.claude/kit-templates/agents/debugger.agent.md.template'),
      ),
    );
    const ignore = readFileSync(join(root, '.claude/debug/.gitignore'), 'utf8');
    assert.match(ignore, /^\*$/m, 'logs ignored');
    assert.match(ignore, /^!\.gitignore$/m, 'the .gitignore stays tracked');

    // SessionStart hook wired, and doctor validates it (stays exit 0).
    const settings = readJson(join(root, '.claude/settings.json'));
    const cmds = (settings.hooks.SessionStart ?? []).flatMap((g) =>
      g.hooks.map((h) => h.command),
    );
    assert.ok(cmds.some((c) => c.includes('debug-session-check.mjs')));
    assert.equal(runCli(['doctor', root]).status, 0);

    // Keep the exact tag out of this test's own source (a plain literal would make
    // `git grep CLAUDE-DEBUG` flag test/ in the kit's own repo).
    const MARKER = ['CLAUDE', 'DEBUG'].join('-');

    // Clean tree, no session log → the backstop says nothing.
    let hook = runScript(root, '.claude/scripts/debug-session-check.mjs');
    assert.equal(hook.status, 0);
    assert.equal(hook.stdout.trim(), '', 'quiet when nothing is in flight');

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
    assert.equal(hook.status, 0);
    assert.match(hook.stdout, /open debug session/);
    assert.match(hook.stdout, /login-500\.jsonl/);
    assert.match(hook.stdout, /instrumentation/);
    assert.match(hook.stdout, /game\.ts/);
    // The payload files carry the tag too, but they live under .claude/ (excluded),
    // so they never count as orphaned instrumentation.
    assert.ok(!hook.stdout.includes('SKILL.md'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OM4: debug-session is off by default and core does not stage its template', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    assert.equal(runCli(['init', '--yes', root]).status, 0);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    assert.ok(!manifest.modules.includes('debug-session'));

    // The always-staged reference templates land...
    assert.ok(
      existsSync(
        join(root, '.claude/kit-templates/agents/reviewer.agent.md.template'),
      ),
    );
    // ...but the debugger template ships only with its opt-in module (like archivist).
    assert.ok(
      !existsSync(
        join(root, '.claude/kit-templates/agents/debugger.agent.md.template'),
      ),
    );
    assert.ok(
      !existsSync(join(root, '.claude/scripts/debug-session-check.mjs')),
    );
    assert.ok(!existsSync(join(root, '.claude/skills/debug-session/SKILL.md')));
    assert.ok(!existsSync(join(root, '.claude/debug/.gitignore')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
