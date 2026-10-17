import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useRepo } from '#test/repo';
import { checkSkillBodySize } from '../skill-body-size.js';

function stageSkill(root: string, name: string, bodyBytes: number): void {
  const dir = join(root, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  const body = 'x'.repeat(bodyBytes);
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: a skill\n---\n${body}`,
  );
}

describe('checkSkillBodySize', () => {
  it('warns for a body one byte over the cap', () => {
    const root = useRepo('pnpm-monorepo');
    stageSkill(root, 'orchestrate', 20_001);

    expect(checkSkillBodySize(root).findings).toEqual([
      {
        level: 'WARN',
        msg: ".claude/skills/orchestrate/SKILL.md body is 20001 bytes, over the 20000-byte cap. Compaction re-injects only the first 5,000 tokens of a skill, so the tail is lost. Move detail into the skill's references.",
      },
    ]);
  });

  it('does not warn for a body exactly at the cap', () => {
    const root = useRepo('pnpm-monorepo');
    stageSkill(root, 'orchestrate', 20_000);

    expect(checkSkillBodySize(root).findings).toEqual([]);
  });

  it('excludes the frontmatter from the measured body', () => {
    const root = useRepo('pnpm-monorepo');
    stageSkill(root, 'small', 300);

    expect(checkSkillBodySize(root).readouts).toEqual([
      '1 installed skill measured, largest body 300 bytes',
    ]);
  });

  it('reports the largest body across several skills', () => {
    const root = useRepo('pnpm-monorepo');
    stageSkill(root, 'small', 300);
    stageSkill(root, 'medium', 900);

    expect(checkSkillBodySize(root).readouts).toEqual([
      '2 installed skills measured, largest body 900 bytes',
    ]);
  });

  it('returns nothing when no skills directory exists', () => {
    const root = useRepo('pnpm-monorepo');

    expect(checkSkillBodySize(root)).toEqual({ findings: [], readouts: [] });
  });
});
