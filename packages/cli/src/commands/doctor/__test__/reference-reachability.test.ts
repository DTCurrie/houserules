import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeCtx } from '#test/ctx-builder';
import { useRepo } from '#test/repo';
import type { Ctx } from '../../../detect.js';
import {
  checkReferenceReachability,
  referenceLinksIn,
} from '../reference-reachability.js';

function write(root: string, rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
}

function ctxInstalling(...dests: string[]): Ctx {
  const base = makeCtx();
  return {
    ...base,
    claude: {
      ...base.claude,
      manifest: {
        kitVersion: '1.0.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        modules: ['core'],
        files: Object.fromEntries(dests.map((dest) => [dest, 'hash'])),
      },
    },
  };
}

function messages(root: string, ctx: Ctx): string[] {
  return checkReferenceReachability(root, ctx).findings.map((f) => f.msg);
}

describe('referenceLinksIn', () => {
  it('finds a backticked rule-relative link', () => {
    expect(referenceLinksIn('see `../reference/wcag22.md` for more')).toEqual([
      '../reference/wcag22.md',
    ]);
  });

  it('finds a repo-relative link, which is how a skill spells it', () => {
    expect(
      referenceLinksIn('grep .claude/reference/wcag22.md for each'),
    ).toEqual(['.claude/reference/wcag22.md']);
  });

  it('finds the target inside a markdown link without doubling it', () => {
    expect(
      referenceLinksIn('[`../reference/x.md`](../reference/x.md)'),
    ).toEqual(['../reference/x.md', '../reference/x.md']);
  });

  it('stops at the .md and leaves an anchor fragment out', () => {
    expect(referenceLinksIn('see `../reference/x.md#contrast`')).toEqual([
      '../reference/x.md',
    ]);
  });

  it('finds nothing in prose that names no reference doc', () => {
    expect(referenceLinksIn('see `../rules/design.md`')).toEqual([]);
  });
});

describe('checkReferenceReachability', () => {
  it('is silent when every doc is linked and every link resolves', () => {
    const root = useRepo('pnpm-monorepo');
    write(root, '.claude/reference/wcag22.md', '# WCAG\n');
    write(root, '.claude/rules/a11y.md', 'See `../reference/wcag22.md`.\n');

    expect(
      messages(root, ctxInstalling('.claude/reference/wcag22.md')),
    ).toEqual([]);
  });

  it('warns about a rule linking a reference doc that is not installed', () => {
    const root = useRepo('pnpm-monorepo');
    write(root, '.claude/reference/wcag22.md', '# WCAG\n');
    write(root, '.claude/rules/a11y.md', 'See `../reference/wcag22.md`.\n');
    write(root, '.claude/rules/design.md', 'See `../reference/ghost.md`.\n');

    expect(
      messages(root, ctxInstalling('.claude/reference/wcag22.md')),
    ).toEqual([
      '.claude/rules/design.md: links ../reference/ghost.md, which is not installed. A rule pointing at an optional file dangles wherever that option was not chosen.',
    ]);
  });

  it('warns about a reference doc nothing links', () => {
    const root = useRepo('pnpm-monorepo');
    write(root, '.claude/reference/orphan.md', '# Orphan\n');

    expect(
      messages(root, ctxInstalling('.claude/reference/orphan.md')),
    ).toEqual([
      '.claude/reference/orphan.md: no installed rule, skill, or agent links it, so nothing will ever route a reader to it. Add a routing line to the rule that owns the topic.',
    ]);
  });

  it('leaves a doc the kit never installed alone, since an unlinked file of your own is yours', () => {
    const root = useRepo('pnpm-monorepo');
    write(root, '.claude/reference/mine.md', '# Mine\n');

    expect(messages(root, ctxInstalling())).toEqual([]);
  });

  it('still warns about a dangling link out of a file the kit never installed', () => {
    const root = useRepo('pnpm-monorepo');
    write(root, '.claude/reference/mine.md', '# Mine\n');
    write(root, '.claude/rules/mine.md', 'See `../reference/ghost.md`.\n');

    expect(messages(root, ctxInstalling())).toEqual([
      '.claude/rules/mine.md: links ../reference/ghost.md, which is not installed. A rule pointing at an optional file dangles wherever that option was not chosen.',
    ]);
  });

  it('counts a skill as an inbound link, since a skill routes a reader too', () => {
    const root = useRepo('pnpm-monorepo');
    write(root, '.claude/reference/wcag22.md', '# WCAG\n');
    write(
      root,
      '.claude/skills/a11y-review/SKILL.md',
      'Grep `.claude/reference/wcag22.md` for each criterion.\n',
    );

    expect(
      messages(root, ctxInstalling('.claude/reference/wcag22.md')),
    ).toEqual([]);
  });

  it('counts an agent as an inbound link', () => {
    const root = useRepo('pnpm-monorepo');
    write(root, '.claude/reference/wcag22.md', '# WCAG\n');
    write(
      root,
      '.claude/agents/a11y-reviewer.md',
      'Read `../reference/wcag22.md` before judging.\n',
    );

    expect(
      messages(root, ctxInstalling('.claude/reference/wcag22.md')),
    ).toEqual([]);
  });

  it('stays silent about a doc that was never installed, which is how an unchosen option reads', () => {
    const root = useRepo('pnpm-monorepo');
    write(root, '.claude/reference/design-layout.md', '# Layout\n');
    write(
      root,
      '.claude/rules/design.md',
      'See `../reference/design-layout.md`.\n',
    );

    expect(
      messages(root, ctxInstalling('.claude/reference/design-layout.md')),
    ).toEqual([]);
  });

  it('reports how many docs it inspected so a clean run still says it ran', () => {
    const root = useRepo('pnpm-monorepo');
    write(root, '.claude/reference/a.md', '# A\n');
    write(root, '.claude/reference/b.md', '# B\n');
    write(
      root,
      '.claude/rules/r.md',
      'See `../reference/a.md` and `../reference/b.md`.\n',
    );

    expect(
      checkReferenceReachability(
        root,
        ctxInstalling('.claude/reference/a.md', '.claude/reference/b.md'),
      ).readouts,
    ).toEqual(['reference reachability: 2 doc(s) inspected']);
  });

  it('returns nothing at all for a repo with no reference directory', () => {
    const root = useRepo('pnpm-monorepo');

    expect(checkReferenceReachability(root, ctxInstalling())).toEqual({
      findings: [],
      readouts: [],
    });
  });
});
