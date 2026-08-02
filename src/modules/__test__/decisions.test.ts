import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { settingsOf } from '#test/installed-tree';

describe('decisions', () => {
  it('is absent from a default install', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    expect(existsSync(join(root, '.claude/scripts/decision-log.mjs'))).toBe(
      false,
    );
  });

  describe('when enabled', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', {
        modules: 'decisions',
      });
    });

    it('installs the decision-log script', () => {
      expect(existsSync(join(root, '.claude/scripts/decision-log.mjs'))).toBe(
        true,
      );
    });

    it('installs the decide skill', () => {
      expect(existsSync(join(root, '.claude/skills/decide/SKILL.md'))).toBe(
        true,
      );
    });

    it('installs the decision-reviewer agent', () => {
      expect(
        existsSync(join(root, '.claude/agents/decision-reviewer.md')),
      ).toBe(true);
    });

    it('grants the decision-log script permission in settings', () => {
      const settings = settingsOf(root);

      expect(settings.permissions?.allow).toContain(
        'Bash(node .claude/scripts/decision-log.mjs:*)',
      );
    });

    it('points CLAUDE.md at the decide skill', () => {
      expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toContain(
        '`/decide` skill',
      );
    });
  });
});
