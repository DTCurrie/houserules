import { describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useRepo, useInstalledRepo } from '#test/repo';
import { manifestOf } from '#test/installed-tree';
import { detect } from '../../detect.js';
import { check } from '../rename.js';

describe('rename', () => {
  it('is disabled for a repo with no TypeScript', () => {
    const root = useInstalledRepo('npm-single');
    const manifest = manifestOf(root);
    expect(manifest.modules).not.toContain('rename');
    expect(
      existsSync(join(root, '.claude/scripts/rename.mjs')),
      'rename.mjs not installed',
    ).toBe(false);
  });

  it('warns with the install fix when typescript is detected from a tsconfig but does not resolve from the root', () => {
    const root = useRepo('npm-single');
    writeFileSync(join(root, 'tsconfig.json'), '{}\n');
    const ctx = detect(root);

    const result = check(ctx);

    expect(ctx.typescript).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.level).toBe('WARN');
    expect(result.findings[0]?.msg).toContain(
      'Add typescript as a dev dependency at the repo root',
    );
  });

  it('stays silent when the root package declares typescript', () => {
    const root = useRepo('npm-single');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'root', devDependencies: { typescript: '^5' } }),
    );

    expect(check(detect(root)).findings).toEqual([]);
  });
});
