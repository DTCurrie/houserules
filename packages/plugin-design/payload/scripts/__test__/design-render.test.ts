import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const PLUGIN_DESIGN = fileURLToPath(new URL('../../..', import.meta.url));
const PLUGINS = [{ name: PLUGIN_DESIGN, alias: 'design' }];

function installed(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'design/design',
    plugins: PLUGINS,
  });
}

function design(root: string, ...args: string[]) {
  return runScript(root, '.claude/scripts/design.mjs', { args });
}

describe('design.mjs render', () => {
  it('prints usage and exits non-zero with no target', () => {
    const root = installed();

    const result = design(root, 'render');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('design.mjs render <target>');
  });

  it('exits non-zero fast when the target file is missing', () => {
    const root = installed();
    const startedAt = Date.now();

    const result = design(root, 'render', './does-not-exist.html');
    const elapsedMs = Date.now() - startedAt;

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/No such file: .*does-not-exist\.html\n/);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('installs the cdp-session and rendered-checks libs the render command needs', () => {
    const root = installed();

    expect(existsSync(join(root, '.claude/scripts/lib/cdp-session.mjs'))).toBe(
      true,
    );
    expect(
      existsSync(join(root, '.claude/scripts/lib/rendered-checks.mjs')),
    ).toBe(true);
  });
});
