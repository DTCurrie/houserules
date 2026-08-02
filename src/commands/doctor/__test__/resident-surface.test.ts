import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { useRepo } from '#test/repo';
import {
  checkResidentSurface,
  frontmatterDescription,
  measureResident,
  measureSkillAgentDescriptions,
  parseImports,
  ruleGlobs,
} from '../resident-surface.js';

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function lines(count: number): string {
  return `${'x'.repeat(10)}\n`.repeat(count);
}

describe('parseImports', () => {
  it('matches an @specifier at the start of the line', () => {
    expect(parseImports('@lib/thing.md')).toEqual(['lib/thing.md']);
  });

  it('matches an @specifier that follows whitespace', () => {
    expect(parseImports('see @lib/thing.md for more')).toEqual([
      'lib/thing.md',
    ]);
  });

  it('matches several @specifiers in one text', () => {
    expect(parseImports('@a.md and @b.md')).toEqual(['a.md', 'b.md']);
  });

  it('does not match an email address, since @ must be preceded by whitespace or line start', () => {
    expect(parseImports('contact foo@bar.com for help')).toEqual([]);
  });

  it('returns an empty list for empty text', () => {
    expect(parseImports('')).toEqual([]);
  });
});

describe('ruleGlobs', () => {
  it('parses the inline array form', () => {
    expect(ruleGlobs('---\npaths: [a/**, b/**]\n---\n\nbody')).toEqual([
      'a',
      'b',
    ]);
  });

  it('parses the dashed list form', () => {
    expect(ruleGlobs('---\npaths:\n  - a/**\n  - b/**\n---\n\nbody')).toEqual([
      'a',
      'b',
    ]);
  });

  it('strips single and double quotes around each entry', () => {
    expect(
      ruleGlobs('---\npaths:\n  - \'a/**\'\n  - "b/**"\n---\n\nbody'),
    ).toEqual(['a', 'b']);
  });

  it('strips a trailing /** from an entry', () => {
    expect(ruleGlobs('---\npaths:\n  - src/**\n---\n\nbody')).toEqual(['src']);
  });

  it('drops a bare ** entry', () => {
    expect(ruleGlobs('---\npaths:\n  - "**"\n---\n\nbody')).toEqual([]);
  });

  it('returns an empty list when there is no frontmatter at all', () => {
    expect(ruleGlobs('# just a heading\n')).toEqual([]);
  });

  it('returns an empty list when frontmatter has no paths: key', () => {
    expect(ruleGlobs('---\ndescription: "no globs"\n---\n\nbody')).toEqual([]);
  });

  it('stops the dashed list at the next frontmatter key', () => {
    expect(
      ruleGlobs(
        '---\npaths:\n  - a/**\n  - b/**\ndescription: "next key"\n---\n\nbody',
      ),
    ).toEqual(['a', 'b']);
  });
});

describe('frontmatterDescription', () => {
  it('reads an unquoted description', () => {
    expect(
      frontmatterDescription('---\ndescription: plain text\n---\n\nbody'),
    ).toBe('plain text');
  });

  it('reads a single-quoted description, stripping the quotes', () => {
    expect(
      frontmatterDescription("---\ndescription: 'quoted text'\n---\n\nbody"),
    ).toBe('quoted text');
  });

  it('reads a double-quoted description, stripping the quotes', () => {
    expect(
      frontmatterDescription('---\ndescription: "quoted text"\n---\n\nbody'),
    ).toBe('quoted text');
  });

  it('returns null when frontmatter has no description: key', () => {
    expect(frontmatterDescription('---\npaths: [a]\n---\n\nbody')).toBeNull();
  });

  it('returns null when there is no frontmatter at all', () => {
    expect(frontmatterDescription('# just a heading\n')).toBeNull();
  });
});

describe('measureResident', () => {
  it('returns null when the repo has no resident memory file and no rules', () => {
    const root = useRepo('pnpm-single');

    expect(measureResident(root)).toBeNull();
  });

  it('sums .claude/CLAUDE.md into the total alongside the root CLAUDE.md', () => {
    const root = useRepo('pnpm-single');
    write(root, 'CLAUDE.md', 'a'.repeat(400));
    write(root, '.claude/CLAUDE.md', 'b'.repeat(400));

    expect(measureResident(root)?.chars).toBe(800);
  });

  it('follows an @-import and counts the imported file', () => {
    const root = useRepo('pnpm-single');
    write(root, 'CLAUDE.md', '@docs/extra.md\n');
    write(root, 'docs/extra.md', 'c'.repeat(100));

    expect(measureResident(root)?.imports).toBe(1);
  });

  it('ignores an @specifier that resolves to no file on disk', () => {
    const root = useRepo('pnpm-single');
    write(root, 'CLAUDE.md', '@docs/absent.md\n');

    expect(measureResident(root)?.imports).toBe(0);
  });

  it('lists a globless rule as resident', () => {
    const root = useRepo('pnpm-single');
    write(root, '.claude/rules/always.md', '# always\n');

    expect(measureResident(root)?.globless).toEqual([
      '.claude/rules/always.md',
    ]);
  });

  it('excludes a path-scoped rule from the globless list', () => {
    const root = useRepo('pnpm-single');
    write(root, 'CLAUDE.md', 'a'.repeat(400));
    write(root, '.claude/rules/scoped.md', '---\npaths:\n  - src/**\n---\n');

    expect(measureResident(root)?.globless).toEqual([]);
  });

  it('estimates tokens at four characters each', () => {
    const root = useRepo('pnpm-single');
    write(root, 'CLAUDE.md', 'a'.repeat(400));

    expect(measureResident(root)?.tokens).toBe(100);
  });
});

describe('measureSkillAgentDescriptions', () => {
  it('returns null when the repo has neither skills nor agents', () => {
    const root = useRepo('pnpm-single');

    expect(measureSkillAgentDescriptions(root)).toBeNull();
  });

  it('counts one skill and one agent separately', () => {
    const root = useRepo('pnpm-single');
    write(root, '.claude/skills/a/SKILL.md', '---\ndescription: ab\n---\n');
    write(root, '.claude/agents/b.md', '---\ndescription: cde\n---\n');

    expect(measureSkillAgentDescriptions(root)).toMatchObject({
      skills: 1,
      agents: 1,
      chars: 5,
    });
  });

  it('skips a skill whose frontmatter carries no description', () => {
    const root = useRepo('pnpm-single');
    write(root, '.claude/skills/a/SKILL.md', '---\nname: a\n---\n');
    write(root, '.claude/agents/b.md', '---\ndescription: cde\n---\n');

    expect(measureSkillAgentDescriptions(root)?.skills).toBe(0);
  });

  it('ignores a non-markdown file in the agents directory', () => {
    const root = useRepo('pnpm-single');
    write(root, '.claude/agents/b.md', '---\ndescription: cde\n---\n');
    write(root, '.claude/agents/notes.txt', 'description: ignored\n');

    expect(measureSkillAgentDescriptions(root)?.agents).toBe(1);
  });
});

describe('checkResidentSurface', () => {
  it('reports headroom when the resident surface is under budget', () => {
    const root = useRepo('pnpm-single');
    write(root, 'CLAUDE.md', 'a'.repeat(400));

    expect(checkResidentSurface(root).readouts[0]).toContain('headroom');
  });

  it('warns once the resident surface exceeds the token budget', () => {
    const root = useRepo('pnpm-single');
    write(root, 'CLAUDE.md', 'a'.repeat(20_000));

    expect(checkResidentSurface(root).findings).toContainEqual(
      expect.objectContaining({
        level: 'WARN',
        msg: expect.stringContaining('always-loaded context exceeds budget'),
      }),
    );
  });

  it('warns once the resident surface exceeds the line budget while under the token budget', () => {
    const root = useRepo('pnpm-single');
    write(root, 'CLAUDE.md', lines(250));

    expect(checkResidentSurface(root).findings).toContainEqual(
      expect.objectContaining({
        msg: expect.stringContaining('always-loaded context exceeds budget'),
      }),
    );
  });

  it('pushes a skill/agent tier over budget that neither tier exceeds alone', () => {
    const root = useRepo('pnpm-single');
    write(root, 'CLAUDE.md', 'a'.repeat(15_000));
    write(
      root,
      '.claude/skills/a/SKILL.md',
      `---\ndescription: ${'d'.repeat(2000)}\n---\n`,
    );

    expect(checkResidentSurface(root).findings).toContainEqual(
      expect.objectContaining({
        msg: expect.stringContaining('skill/agent descriptions'),
      }),
    );
  });

  it('warns that a globless rule loads on every turn', () => {
    const root = useRepo('pnpm-single');
    write(root, '.claude/rules/always.md', '# always\n');

    expect(checkResidentSurface(root).findings).toContainEqual(
      expect.objectContaining({
        msg: expect.stringContaining('loaded on EVERY turn'),
      }),
    );
  });

  it('lists a nested package CLAUDE.md as on-demand rather than summing it', () => {
    const root = useRepo('pnpm-monorepo');
    write(root, 'CLAUDE.md', 'a'.repeat(400));
    write(root, 'apps/studio/CLAUDE.md', 'b'.repeat(40_000));

    const result = checkResidentSurface(root);

    expect(result.readouts).toContainEqual(
      expect.stringContaining('nested (on-demand, not in resident total)'),
    );
    expect(result.findings).toEqual([]);
  });

  it('returns nothing to report when there is no resident surface at all', () => {
    const root = useRepo('pnpm-single');

    expect(checkResidentSurface(root)).toEqual({ findings: [], readouts: [] });
  });
});
