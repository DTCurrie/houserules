import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeCtx } from '#test/ctx-builder';
import type { Action } from '@agent-kit/api';
import { formatterMangleHint } from '../formatter-mangle.js';
import {
  PRETTIERIGNORE_REGION,
  prettierGuardActions,
} from '../prettier-guard.js';

const REMEDY = 'Run `npx agent-kit update --force` to restore them';

function regionBody(actions: Action[]): string {
  const region = actions.find(
    (a): a is Extract<Action, { kind: 'region' }> =>
      a.kind === 'region' && a.dest === '.prettierignore',
  );
  if (!region) throw new Error('expected a .prettierignore region action');
  return region.body;
}

function emptyRoot(): string {
  return mkdtempSync(join(tmpdir(), 'kit-mangle-'));
}

function kitPaths(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `.claude/scripts/s${i}.mjs`);
}

describe('formatterMangleHint', () => {
  it('blames a formatter once more than a couple of kit files read as edited', () => {
    const hint = formatterMangleHint(emptyRoot(), kitPaths(3), REMEDY);

    expect(hint).toMatch(/3 kit-owned file\(s\) under \.claude\//);
    expect(hint).toMatch(/likely cause/);
    expect(hint).toContain(REMEDY);
  });

  it('stays silent at two edited files, which is a plausible deliberate edit', () => {
    expect(formatterMangleHint(emptyRoot(), kitPaths(2), REMEDY)).toBeNull();
  });

  it('stays silent when a .prettierignore block already rules the formatter out', () => {
    const root = emptyRoot();
    writeFileSync(
      join(root, '.prettierignore'),
      `${PRETTIERIGNORE_REGION.start}\n.claude/scripts/\n${PRETTIERIGNORE_REGION.end}\n`,
    );

    expect(formatterMangleHint(root, kitPaths(5), REMEDY)).toBeNull();
  });

  it('counts only paths under .claude/, since the formatter claim is about that subtree', () => {
    const outside = ['CLAUDE.md', 'README.md', 'package.json'];

    expect(formatterMangleHint(emptyRoot(), outside, REMEDY)).toBeNull();
  });
});

describe('prettierGuardActions, derived .prettierignore body', () => {
  it('protects a directory a copy action writes under .claude/, such as output-styles', () => {
    const ctx = makeCtx({ prettier: true });
    const plan: Action[] = [
      {
        kind: 'copy',
        src: '/payload/output-styles/output-prose.md',
        dest: '.claude/output-styles/output-prose.md',
        module: 'output-prose',
        reason: 'terse output style',
      },
    ];

    const body = regionBody(prettierGuardActions(ctx, plan));

    expect(body).toContain('.claude/output-styles/');
  });

  it('excludes a seed action, since it is user-owned and never refreshed', () => {
    const ctx = makeCtx({ prettier: true });
    const plan: Action[] = [
      {
        kind: 'seed',
        dest: '.claude/seeded/example.json',
        content: '{}',
        module: 'core',
        reason: 'per-repo seed',
      },
    ];

    const body = regionBody(prettierGuardActions(ctx, plan));

    expect(body).not.toContain('.claude/seeded/');
  });

  it('excludes a region action, since only its marker span is hashed, not the whole file', () => {
    const ctx = makeCtx({ prettier: true });
    const plan: Action[] = [
      {
        kind: 'region',
        dest: '.claude/settings.json',
        body: '',
        region: {
          id: 'x',
          start: '<!-- s -->',
          end: '<!-- e -->',
          anchor: 'eof',
        },
        module: 'core',
        reason: 'merged region',
      },
    ];

    const body = regionBody(prettierGuardActions(ctx, plan));

    expect(body).not.toContain('.claude/settings.json');
  });
});
