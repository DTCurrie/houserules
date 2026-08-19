import { describe, expect, it } from 'vitest';

import { checkAccessibilityLinter } from '../linter-check.js';
import type { Ctx } from '@houserules/api';

function ctxWith(dependencies: Record<string, string>): Ctx {
  return {
    rootPkg: { name: 'fixture', devDependencies: dependencies },
    packages: [],
  } as unknown as Ctx;
}

function ctxWithWorkspacePackage(dependencies: Record<string, string>): Ctx {
  return {
    rootPkg: { name: 'root' },
    packages: [
      {
        name: '@fix/web',
        dir: '/tmp/web',
        relDir: 'apps/web',
        pkg: { name: '@fix/web', dependencies },
      },
    ],
  } as unknown as Ctx;
}

describe('checkAccessibilityLinter', () => {
  it('warns naming the package to install when react has no a11y linter', () => {
    const result = checkAccessibilityLinter(ctxWith({ react: '^19.0.0' }));

    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding?.level).toBe('WARN');
    expect(finding?.msg).toContain('eslint-plugin-jsx-a11y');
  });

  it('stays silent when the linter is already present', () => {
    const result = checkAccessibilityLinter(
      ctxWith({ react: '^19.0.0', 'eslint-plugin-jsx-a11y': '^6.10.0' }),
    );

    expect(result.findings).toEqual([]);
    expect(result.readouts.join('\n')).toContain('eslint-plugin-jsx-a11y');
  });

  it.each([
    { framework: 'vue', linter: 'eslint-plugin-vuejs-accessibility' },
    { framework: 'svelte', linter: 'svelte-check' },
  ])('warns for $framework naming $linter', ({ framework, linter }) => {
    const result = checkAccessibilityLinter(ctxWith({ [framework]: '^5.0.0' }));

    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding?.msg).toContain(linter);
  });

  it('finds a framework declared in a workspace package, not only the root', () => {
    const result = checkAccessibilityLinter(
      ctxWithWorkspacePackage({ vue: '^3.5.0' }),
    );

    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding?.msg).toContain('eslint-plugin-vuejs-accessibility');
  });

  it('warns once per framework when a repo uses two', () => {
    const result = checkAccessibilityLinter(
      ctxWith({ react: '^19.0.0', vue: '^3.5.0' }),
    );

    expect(result.findings).toHaveLength(2);
  });

  it('reports no framework rather than warning on a repo with no markup', () => {
    const result = checkAccessibilityLinter(ctxWith({ typescript: '^6.0.0' }));

    expect(result.findings).toEqual([]);
    expect(result.readouts.join('\n')).toContain('no markup framework');
  });

  it.each([
    { label: 'a null rootPkg', ctx: { rootPkg: null, packages: [] } },
    {
      label: 'a dependencies field that is not an object',
      ctx: { rootPkg: { dependencies: 'broken' }, packages: [] },
    },
    {
      label: 'a workspace package with no manifest',
      ctx: { rootPkg: null, packages: [{ name: 'x', pkg: null }] },
    },
  ])('returns cleanly given $label', ({ ctx }) => {
    expect(() => checkAccessibilityLinter(ctx as unknown as Ctx)).not.toThrow();
  });
});
