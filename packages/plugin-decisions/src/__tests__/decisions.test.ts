import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { settingsOf } from '#test/installed-tree';

const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('decisions', () => {
  it('is absent from a default install', () => {
    const root = useInstalledRepo('pnpm-monorepo');

    const scriptPath = join(root, '.claude/scripts/decision-log.mjs');

    expect(existsSync(scriptPath), `${scriptPath} absent`).toBe(false);
  });

  describe('when enabled', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', {
        modules: 'decisions/decisions',
        plugins: [{ name: PLUGIN_ROOT, alias: 'decisions' }],
      });
    });

    it('installs the decision-log script', () => {
      const scriptPath = join(root, '.claude/scripts/decision-log.mjs');

      expect(existsSync(scriptPath), `${scriptPath} exists`).toBe(true);
    });

    it('installs the decide skill', () => {
      const skillPath = join(root, '.claude/skills/decide/SKILL.md');

      expect(existsSync(skillPath), `${skillPath} exists`).toBe(true);
    });

    it('installs the decision-reviewer agent', () => {
      expect(
        existsSync(join(root, '.claude/agents/decision-reviewer.md')),
        '.claude/agents/decision-reviewer.md exists',
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
        'Record it with `/decide`',
      );
    });
  });
});
