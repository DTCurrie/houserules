import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { settingsOf } from '#test/installed-tree';

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('backlog', () => {
  it('is absent from a default install', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    expect(existsSync(join(root, '.claude/scripts/backlog-log.mjs'))).toBe(
      false,
    );
  });

  describe('when enabled', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', {
        modules: 'backlog/backlog',
        plugins: [{ name: PLUGIN_ROOT, alias: 'backlog' }],
      });
    });

    it('installs the backlog-log script', () => {
      expect(existsSync(join(root, '.claude/scripts/backlog-log.mjs'))).toBe(
        true,
      );
    });

    it('installs the backlog-add skill', () => {
      expect(
        existsSync(join(root, '.claude/skills/backlog-add/SKILL.md')),
      ).toBe(true);
    });

    it('installs the backlog-reviewer agent', () => {
      expect(existsSync(join(root, '.claude/agents/backlog-reviewer.md'))).toBe(
        true,
      );
    });

    it('grants the backlog-log script permission in settings', () => {
      const settings = settingsOf(root);

      expect(settings.permissions?.allow).toContain(
        'Bash(node .claude/scripts/backlog-log.mjs:*)',
      );
    });

    it('does not install its own reviewer-gate script, since core now gates every subagent', () => {
      expect(existsSync(join(root, '.claude/scripts/reviewer-gate.mjs'))).toBe(
        false,
      );
    });

    it('points CLAUDE.md at the backlog-add skill', () => {
      expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain(
        '`/backlog-add`',
      );
    });
  });
});
