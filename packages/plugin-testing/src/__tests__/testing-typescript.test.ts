import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';

const PLUGIN_TESTING = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_TESTING, alias: 'testing' }];

describe('testing plugin, typescript guide option', () => {
  it('installs testing-typescript.md when the typescript guide is selected', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'testing/testing',
      moduleOptions: { 'testing/testing': ['typescript'] },
      plugins: PLUGINS,
    });

    expect(existsSync(join(root, '.claude/rules/testing-typescript.md'))).toBe(
      true,
    );
  });

  it('does not install testing-typescript.md when the javascript guide is selected instead', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'testing/testing',
      moduleOptions: { 'testing/testing': ['javascript'] },
      plugins: PLUGINS,
    });

    expect(existsSync(join(root, '.claude/rules/testing-typescript.md'))).toBe(
      false,
    );
  });
});
