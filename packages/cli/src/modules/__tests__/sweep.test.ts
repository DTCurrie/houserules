import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';

describe('sweep', () => {
  it('is off by default', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    expect(existsSync(join(root, '.claude/skills/sweep/SKILL.md'))).toBe(false);
  });

  describe('when enabled', () => {
    let root: string;
    let skillText: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', { modules: 'sweep' });
      skillText = readFileSync(
        join(root, '.claude/skills/sweep/SKILL.md'),
        'utf8',
      );
    });

    it('documents the O(shards) discipline', () => {
      expect(skillText).toMatch(/O\(shards\)/);
    });

    it('specifies a haiku or low-effort model', () => {
      expect(skillText).toMatch(/haiku|effort: low/);
    });

    it('passes doctor', () => {
      expect(runCli(['doctor', root]).status).toBe(0);
    });
  });
});
