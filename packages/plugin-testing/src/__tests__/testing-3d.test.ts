import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';

const PLUGIN_TESTING = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_TESTING, alias: 'testing' }];

describe('testing plugin, 3d guide option', () => {
  it('installs testing-3d.md when the 3d guide is selected', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'testing/testing',
      moduleOptions: { 'testing/testing': ['3d'] },
      plugins: PLUGINS,
    });

    expect(existsSync(join(root, '.claude/rules/testing-3d.md'))).toBe(true);
  });

  it('does not install testing-3d.md when the typescript guide is selected instead', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'testing/testing',
      moduleOptions: { 'testing/testing': ['typescript'] },
      plugins: PLUGINS,
    });

    expect(existsSync(join(root, '.claude/rules/testing-3d.md'))).toBe(false);
  });
});
