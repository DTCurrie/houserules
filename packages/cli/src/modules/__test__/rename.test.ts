import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { manifestOf } from '#test/installed-tree';

describe('rename', () => {
  it('is disabled for a repo with no TypeScript', () => {
    const root = useInstalledRepo('npm-single');
    const manifest = manifestOf(root);
    expect(manifest.modules.includes('rename')).toBe(false);
    expect(existsSync(join(root, '.claude/scripts/rename.mjs'))).toBe(false);
  });
});
