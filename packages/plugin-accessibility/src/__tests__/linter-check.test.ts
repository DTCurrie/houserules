import { describe, expect, it } from 'vitest';

import { checkAccessibilityLinter } from '../linter-check.js';
import type { Ctx } from '@houserules/api';

type DependencyField = 'dependencies' | 'devDependencies';

function ctxWithDependenciesIn(
  field: DependencyField,
  dependencies: Record<string, string>,
): Ctx {
  return {
    rootPkg: { name: 'fixture', [field]: dependencies },
    packages: [],
  } as unknown as Ctx;
}

function ctxWith(dependencies: Record<string, string>): Ctx {
  return ctxWithDependenciesIn('devDependencies', dependencies);
}

function withEslint(
  dependencies: Record<string, string>,
  eslint: string | undefined,
): Record<string, string> {
  return eslint === undefined ? dependencies : { ...dependencies, eslint };
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

  it('reads a repo declaring both jsx-a11y plugins as covered, on one readout line', () => {
    const result = checkAccessibilityLinter(
      ctxWith({
        react: '^19.0.0',
        'eslint-plugin-jsx-a11y': '^6.10.2',
        'eslint-plugin-jsx-a11y-x': '^0.2.0',
      }),
    );

    expect(result).toEqual({
      findings: [],
      readouts: [
        'accessibility: react + eslint-plugin-jsx-a11y, eslint-plugin-jsx-a11y-x',
      ],
    });
  });

  it('accepts the jsx-a11y-x fork for react', () => {
    const result = checkAccessibilityLinter(
      ctxWith({
        react: '^19.0.0',
        eslint: '^10.0.0',
        'eslint-plugin-jsx-a11y-x': '^0.2.0',
      }),
    );

    expect(result).toEqual({
      findings: [],
      readouts: ['accessibility: react + eslint-plugin-jsx-a11y-x'],
    });
  });

  it.each([
    { eslint: '^9.0.0', expected: 'eslint-plugin-jsx-a11y' },
    { eslint: '^10.0.0', expected: 'eslint-plugin-jsx-a11y-x' },
    { eslint: '^9.0.0 || ^10.0.0', expected: 'eslint-plugin-jsx-a11y-x' },
    { eslint: '^8.0.0 || ^10.0.0', expected: 'eslint-plugin-jsx-a11y-x' },
    { eslint: undefined, expected: 'eslint-plugin-jsx-a11y-x' },
    { eslint: 'workspace:*', expected: 'eslint-plugin-jsx-a11y-x' },
    { eslint: 'latest', expected: 'eslint-plugin-jsx-a11y-x' },
  ])(
    'tells a react repo declaring eslint $eslint to install $expected',
    ({ eslint, expected }) => {
      const result = checkAccessibilityLinter(
        ctxWith(withEslint({ react: '^19.0.0' }, eslint)),
      );

      expect(result.findings.map(({ msg }) => msg)).toEqual([
        `accessibility: this repo uses react but has no accessibility linter. Install ${expected}. The accessibility rule is guidance and does not check markup mechanically.`,
      ]);
    },
  );

  it('reads the eslint range from a workspace package when the framework sits at the root', () => {
    const ctx = {
      rootPkg: { name: 'root', dependencies: { react: '^19.0.0' } },
      packages: [
        { name: '@fix/lint', pkg: { devDependencies: { eslint: '^9.0.0' } } },
      ],
    } as unknown as Ctx;

    const result = checkAccessibilityLinter(ctx);

    expect(result.findings[0]?.msg).toContain(
      'Install eslint-plugin-jsx-a11y.',
    );
  });
});

describe('checkAccessibilityLinter, given an astro repo', () => {
  it.each([
    { field: 'dependencies', plugin: 'eslint-plugin-jsx-a11y-x' },
    { field: 'devDependencies', plugin: 'eslint-plugin-jsx-a11y-x' },
    { field: 'dependencies', plugin: 'eslint-plugin-jsx-a11y' },
    { field: 'devDependencies', plugin: 'eslint-plugin-jsx-a11y' },
  ] as const)(
    'reads eslint-plugin-astro with $plugin in $field as covered',
    ({ field, plugin }) => {
      const result = checkAccessibilityLinter(
        ctxWithDependenciesIn(field, {
          astro: '^5.0.0',
          eslint: '^10.0.0',
          'eslint-plugin-astro': '^3.2.1',
          [plugin]: '^1.0.0',
        }),
      );

      expect(result).toEqual({
        findings: [],
        readouts: [`accessibility: astro + eslint-plugin-astro, ${plugin}`],
      });
    },
  );

  it.each(['dependencies', 'devDependencies'] as const)(
    'warns when %s holds only astro-eslint-parser, naming both halves',
    (field) => {
      const result = checkAccessibilityLinter(
        ctxWithDependenciesIn(field, {
          astro: '^5.0.0',
          'astro-eslint-parser': '^1.2.0',
        }),
      );

      expect(result.findings.map(({ msg }) => msg)).toEqual([
        'accessibility: this repo uses astro but has no accessibility linter. Install eslint-plugin-astro and eslint-plugin-jsx-a11y-x. The accessibility rule is guidance and does not check markup mechanically.',
      ]);
    },
  );

  it.each([
    {
      label:
        'an accessibility plugin without eslint-plugin-astro, on eslint 10',
      dependencies: { eslint: '^10.0.0', 'eslint-plugin-jsx-a11y-x': '^0.2.0' },
      expected: 'Install eslint-plugin-astro.',
    },
    {
      label: 'an accessibility plugin without eslint-plugin-astro, on eslint 9',
      dependencies: { eslint: '^9.0.0', 'eslint-plugin-jsx-a11y': '^6.10.2' },
      expected: 'Install eslint-plugin-astro@1.',
    },
    {
      label: 'eslint-plugin-astro without an accessibility plugin, on eslint 9',
      dependencies: { eslint: '^9.0.0', 'eslint-plugin-astro': '^1.7.0' },
      expected: 'Install eslint-plugin-jsx-a11y.',
    },
  ])(
    'names only the missing half given $label',
    ({ dependencies, expected }) => {
      const result = checkAccessibilityLinter(
        ctxWith({ astro: '^5.0.0', ...dependencies }),
      );

      expect(result.findings[0]?.msg).toContain(expected);
    },
  );

  it.each([
    {
      eslint: '^9.0.0',
      expected: 'eslint-plugin-astro@1 and eslint-plugin-jsx-a11y',
    },
    {
      eslint: '^10.0.0',
      expected: 'eslint-plugin-astro and eslint-plugin-jsx-a11y-x',
    },
    {
      eslint: '^9.0.0 || ^10.0.0',
      expected: 'eslint-plugin-astro@1 and eslint-plugin-jsx-a11y-x',
    },
    {
      eslint: undefined,
      expected: 'eslint-plugin-astro and eslint-plugin-jsx-a11y-x',
    },
    {
      eslint: '^8.0.0',
      expected: 'eslint-plugin-astro@1 and eslint-plugin-jsx-a11y',
    },
  ])(
    'tells a repo declaring eslint $eslint to install $expected',
    ({ eslint, expected }) => {
      const result = checkAccessibilityLinter(
        ctxWith(withEslint({ astro: '^5.0.0' }, eslint)),
      );

      expect(result.findings[0]?.msg).toContain(`Install ${expected}.`);
    },
  );
});
