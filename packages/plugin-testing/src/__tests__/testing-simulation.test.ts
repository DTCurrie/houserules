import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';

const PLUGIN_TESTING = fileURLToPath(new URL('../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_TESTING, alias: 'testing' }];

describe('testing plugin, simulation guide option', () => {
  it('installs testing-simulation.md when the simulation guide is selected', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'testing/testing',
      moduleOptions: { 'testing/testing': ['simulation'] },
      plugins: PLUGINS,
    });

    expect(existsSync(join(root, '.claude/rules/testing-simulation.md'))).toBe(
      true,
    );
  });

  it('does not install testing-simulation.md when the typescript guide is selected instead', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'testing/testing',
      moduleOptions: { 'testing/testing': ['typescript'] },
      plugins: PLUGINS,
    });

    expect(existsSync(join(root, '.claude/rules/testing-simulation.md'))).toBe(
      false,
    );
  });

  // The `dir:tests` choice carries no rule file of its own (guideRules has no entry for
  // it), so this only pins that it does not suppress the guide chosen alongside it. The
  // advise text's `--test-dir tests` substitution is not observable through
  // useInstalledRepo, which returns only the installed tree.
  it('installs the base rule and the typescript guide when a test-directory choice is also selected', () => {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'testing/testing',
      moduleOptions: { 'testing/testing': ['typescript', 'dir:tests'] },
      plugins: PLUGINS,
    });

    expect(existsSync(join(root, '.claude/rules/testing.md'))).toBe(true);
    expect(existsSync(join(root, '.claude/rules/testing-typescript.md'))).toBe(
      true,
    );
    expect(existsSync(join(root, '.claude/rules/testing-simulation.md'))).toBe(
      false,
    );
  });
});
