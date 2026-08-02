import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runCli, runScript } from '#test/run';
import { hookCommandsFor, manifestOf, settingsOf } from '#test/installed-tree';

describe('debug-session', () => {
  describe('when enabled', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', { modules: 'debug-session' });
    });

    it('installs the skill, the backstop hook script, and the debugger agent template', () => {
      for (const rel of [
        '.claude/skills/debug-session/SKILL.md',
        '.claude/scripts/debug-session-check.mjs',
        '.claude/kit-templates/agents/debugger.agent.md.template',
      ]) {
        expect(existsSync(join(root, rel)), `missing ${rel}`).toBeTruthy();
      }
    });

    it('self-gitignores its debug log directory while keeping the .gitignore itself tracked', () => {
      const ignore = readFileSync(
        join(root, '.claude/debug/.gitignore'),
        'utf8',
      );
      expect(ignore).toMatch(/^\*$/m);
      expect(ignore).toMatch(/^!\.gitignore$/m);
    });

    it('wires the backstop hook into SessionStart', () => {
      const cmds = hookCommandsFor(settingsOf(root), 'SessionStart');
      expect(
        cmds.some((c: string) => c.includes('debug-session-check.mjs')),
      ).toBeTruthy();
    });

    it('passes doctor validation', () => {
      expect(runCli(['doctor', root]).status).toBe(0);
    });

    it('stays quiet when there is no open debug session', () => {
      const hook = runScript(root, '.claude/scripts/debug-session-check.mjs');
      expect(hook.status).toBe(0);
      expect(hook.stdout.trim()).toBe('');
    });

    it('reports an open session log and orphaned instrumentation, excluding the kit’s own payload files', () => {
      // Built from parts: a literal tag would make `git grep CLAUDE-DEBUG` flag this suite.
      const MARKER = ['CLAUDE', 'DEBUG'].join('-');
      writeFileSync(
        join(root, '.claude/debug/login-500.jsonl'),
        '{"hyp":"H1","at":"entry"}\n',
      );
      writeFileSync(
        join(root, 'games/cityville/src/game.ts'),
        `export const game = 1; // ${MARKER}\n`,
      );
      const hook = runScript(root, '.claude/scripts/debug-session-check.mjs');
      expect(hook.status).toBe(0);
      expect(hook.stdout).toMatch(/open debug session/);
      expect(hook.stdout).toMatch(/login-500\.jsonl/);
      expect(hook.stdout).toMatch(/instrumentation/);
      expect(hook.stdout).toMatch(/game\.ts/);
      expect(hook.stdout.includes('SKILL.md')).toBe(false);
    });
  });

  describe('by default', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo');
    });

    it('is not enabled', () => {
      const manifest = manifestOf(root);
      expect(manifest.modules.includes('debug-session')).toBe(false);
    });

    it('still stages the always-shipped reviewer agent template', () => {
      expect(
        existsSync(
          join(root, '.claude/kit-templates/agents/reviewer.agent.md.template'),
        ),
      ).toBeTruthy();
    });

    it('does not stage the debugger template, script, or skill', () => {
      expect(
        existsSync(
          join(root, '.claude/kit-templates/agents/debugger.agent.md.template'),
        ),
      ).toBe(false);
      expect(
        existsSync(join(root, '.claude/scripts/debug-session-check.mjs')),
      ).toBe(false);
      expect(
        existsSync(join(root, '.claude/skills/debug-session/SKILL.md')),
      ).toBe(false);
      expect(existsSync(join(root, '.claude/debug/.gitignore'))).toBe(false);
    });
  });
});
