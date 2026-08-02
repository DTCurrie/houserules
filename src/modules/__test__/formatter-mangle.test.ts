import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatterMangleHint } from '../formatter-mangle.js';
import { PRETTIERIGNORE_REGION } from '../prettier-guard.js';

const REMEDY = 'Run `npx claude-kit update --force` to restore them';

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
