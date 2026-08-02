import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';

describe('reviewers', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', {
      modules: 'reviewers',
    });
  });

  it.each(['cityville-reviewer.md', 'studio-reviewer.md'])(
    'marks the %s seed as DRAFT',
    (name) => {
      const text = readFileSync(join(root, '.claude/agents', name), 'utf8');
      expect(text).toMatch(/^description: "DRAFT/m);
    },
  );

  it('flags the DRAFT reviewers in doctor while staying exit 0', () => {
    const doc = runCli(['doctor', root]);
    expect(doc.status, doc.stdout).toBe(0);
    expect(doc.stdout).toMatch(/DRAFT/);
  });

  it('ships the /review-change dispatch skill', () => {
    const dispatchRoot = useInstalledRepo('pnpm-monorepo', {
      modules: 'reviewers',
    });
    const skillPath = join(
      dispatchRoot,
      '.claude/skills/review-change/SKILL.md',
    );
    expect(existsSync(skillPath), '/review-change skill installed').toBe(true);
    const text = readFileSync(skillPath, 'utf8');
    expect(text).toMatch(/pathPrefix/);
    expect(text).toMatch(/OK.*Conflict.*Gap/s);
  });
});
