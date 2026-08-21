import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';

describe('ready', () => {
  it('ships the /ready pre-handoff skill', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'ready' });
    const skillPath = join(root, '.claude/skills/ready/SKILL.md');
    expect(existsSync(skillPath), '/ready skill installed').toBe(true);
    const text = readFileSync(skillPath, 'utf8');
    expect(text).toMatch(/VERDICT/);
    expect(text).toMatch(/acceptance checklist/i);
    expect(text).toMatch(/backlog/i);
  });
});
