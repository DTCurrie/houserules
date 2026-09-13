import { beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigTarget } from '@houserules/payload/config';
import type { WorkspacePackage } from '@houserules/payload/workspaces';
import {
  fullScopeEntries,
  planLines,
  resolveScope,
  resolveVerifyCommands,
  verifyArgv,
  withDependents,
  type ScopeEntry,
} from '../verify-changed.mjs';
import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';
import { stubRunner } from '#test/runner-stub';
import { editHouseConfig, readJson } from '#test/installed-tree';

interface CityvillePackageJson {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

const SCRIPT = '.claude/scripts/verify-changed.mjs';

function pkg(
  name: string,
  dependencies: Record<string, string> = {},
): WorkspacePackage {
  return {
    name,
    dir: `/repo/packages/${name}`,
    relDir: `packages/${name}`,
    pkg: { name, dependencies },
  };
}

function repoWithStudioDependingOnCityville(): string {
  const root = useInstalledRepo('pnpm-monorepo', { modules: 'verify-changed' });
  const studioPath = join(root, 'apps/studio/package.json');
  const studio = readJson<CityvillePackageJson>(studioPath);
  studio.dependencies = { '@fix/cityville': 'workspace:*' };
  writeFileSync(studioPath, JSON.stringify(studio, null, 2));
  runIn(root, 'git', ['add', '-A']);
  runIn(root, 'git', ['commit', '-qm', 'studio depends on cityville']);
  return root;
}

function useStubVerifyRunner(root: string, { fail = false } = {}): void {
  stubRunner(root, { fail, failMessage: 'type error TS2322' });
  editHouseConfig(root, (config) => {
    const verify = config.verify as { runner?: string };
    verify.runner = './stub-runner.sh';
  });
}

describe('withDependents', () => {
  it('pulls in a package whose dependency was seeded, transitively', () => {
    const packages = [
      pkg('core'),
      pkg('mid', { core: 'workspace:*' }),
      pkg('outer', { mid: 'workspace:*' }),
    ];

    expect(withDependents(new Set(['core']), packages)).toEqual(
      new Set(['core', 'mid', 'outer']),
    );
  });

  it('leaves a package with no dependency on the seed out of scope', () => {
    const packages = [pkg('core'), pkg('unrelated')];

    expect(withDependents(new Set(['core']), packages)).toEqual(
      new Set(['core']),
    );
  });
});

describe('resolveScope', () => {
  const targets: ConfigTarget[] = [
    {
      name: 'cityville',
      pathPrefix: 'games/cityville/',
      packageName: '@fix/cityville',
    },
    { name: 'studio', pathPrefix: 'apps/studio/', packageName: '@fix/studio' },
  ];

  it('maps a single-package repo change to one "changed" entry for the root target', () => {
    expect(
      resolveScope(
        ['src/index.ts'],
        [],
        [{ name: 'root', packageName: 'root-pkg' }],
      ),
    ).toEqual([{ package: 'root-pkg', reason: 'changed', single: true }]);
  });

  it('returns no scope for a single-package repo with only dotfile changes', () => {
    expect(resolveScope(['.claude/config.json'], [], [])).toEqual([]);
  });

  it('defaults a single-package repo with no root target to "."', () => {
    expect(resolveScope(['src/index.ts'], [], [])).toEqual([
      { package: '.', reason: 'changed', single: true },
    ]);
  });

  it('maps a changed path to its target package plus its transitive dependent', () => {
    const packages = [
      pkg('@fix/cityville'),
      pkg('@fix/studio', { '@fix/cityville': 'workspace:*' }),
    ];

    const scope = resolveScope(
      ['games/cityville/src/game.ts'],
      packages,
      targets,
    );

    expect(scope).toEqual(
      expect.arrayContaining([
        { package: '@fix/cityville', reason: 'changed' },
        { package: '@fix/studio', reason: 'dependent' },
      ]),
    );
    expect(scope).toHaveLength(2);
  });

  it('prefers the longer, more specific pathPrefix on a nested overlap', () => {
    const nestedTargets: ConfigTarget[] = [
      { name: 'apps', pathPrefix: 'apps/', packageName: '@fix/apps' },
      {
        name: 'studio',
        pathPrefix: 'apps/studio/',
        packageName: '@fix/studio',
      },
    ];
    const packages = [pkg('@fix/apps'), pkg('@fix/studio')];

    const scope = resolveScope(
      ['apps/studio/src/main.ts'],
      packages,
      nestedTargets,
    );

    expect(scope).toEqual([{ package: '@fix/studio', reason: 'changed' }]);
  });

  it('returns no scope in a monorepo when no changed path matches a target prefix', () => {
    const packages = [pkg('@fix/cityville'), pkg('@fix/studio')];

    expect(resolveScope(['unmapped/file.ts'], packages, targets)).toEqual([]);
  });
});

describe('fullScopeEntries', () => {
  it('marks every workspace package as "full-scope"', () => {
    expect(
      fullScopeEntries([pkg('@fix/cityville'), pkg('@fix/studio')]),
    ).toEqual([
      { package: '@fix/cityville', reason: 'full-scope' },
      { package: '@fix/studio', reason: 'full-scope' },
    ]);
  });

  it('returns an empty list for no packages', () => {
    expect(fullScopeEntries([])).toEqual([]);
  });
});

describe('resolveVerifyCommands', () => {
  const targets: ConfigTarget[] = [
    {
      name: 'cityville',
      packageName: '@fix/cityville',
      verifyCommands: ['custom:verify'],
    },
    { name: 'studio', packageName: '@fix/studio', verifyCommands: null },
  ];

  it('resolves to the target’s verifyCommands override', () => {
    expect(
      resolveVerifyCommands('@fix/cityville', targets, ['verify']),
    ).toEqual(['custom:verify']);
  });

  it('resolves a target with verifyCommands: null to no commands at all', () => {
    expect(resolveVerifyCommands('@fix/studio', targets, ['verify'])).toEqual(
      [],
    );
  });

  it('falls back to the repo default for a package with no target override', () => {
    expect(resolveVerifyCommands('@fix/unmapped', targets, ['verify'])).toEqual(
      ['verify'],
    );
  });
});

describe('verifyArgv', () => {
  it('puts the package after the filter flag when one is set', () => {
    expect(verifyArgv('@fix/cityville', 'verify', '--filter', [])).toEqual([
      '--filter',
      '@fix/cityville',
      'verify',
    ]);
  });

  it('drops the package name and uses the run prefix when the filter flag is empty', () => {
    expect(verifyArgv('.', 'verify', '', ['run'])).toEqual(['run', 'verify']);
  });
});

describe('planLines', () => {
  it('summarizes changed and dependent counts and lists one command line per step', () => {
    const scope: ScopeEntry[] = [
      { package: '@fix/cityville', reason: 'changed', commands: ['verify'] },
      { package: '@fix/studio', reason: 'dependent', commands: ['verify'] },
    ];

    const lines = planLines(scope, 'pnpm', '--filter', [], 'main', false);

    expect(lines[0]).toBe(
      'verify-changed: 2 package(s) in scope (1 changed + 1 dependent) vs base `main`',
    );
    expect(lines).toContain(
      '  @fix/cityville  [changed]  pnpm --filter @fix/cityville verify',
    );
    expect(lines[lines.length - 1]).toBe(
      'Run each command; report one compact line per package: "<pkg>: PASS" or "<pkg>: FAIL (<step>)".',
    );
  });

  it('reports FULL SCOPE in the summary when degraded', () => {
    const scope: ScopeEntry[] = [
      { package: '@fix/cityville', reason: 'full-scope', commands: [] },
    ];

    const lines = planLines(scope, 'pnpm', '--filter', [], 'main', true);

    expect(lines[0]).toBe(
      'verify-changed: 1 package(s), FULL SCOPE (git/config unavailable)',
    );
  });

  it('omits the "+ N dependent" clause when nothing dependent is in scope', () => {
    const scope: ScopeEntry[] = [
      { package: '@fix/cityville', reason: 'changed', commands: [] },
    ];

    const lines = planLines(scope, 'pnpm', '--filter', [], 'main', false);

    expect(lines[0]).toBe(
      'verify-changed: 1 package(s) in scope (1 changed) vs base `main`',
    );
  });
});

describe('verify-changed.mjs --json', () => {
  it('resolves a changed package plus its transitive dependent, with an exact argv per scope entry', () => {
    const root = repoWithStudioDependingOnCityville();
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );
    const r = runScript(root, SCRIPT, { args: ['--json'] });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as {
      degraded: boolean;
      scope: { package: string; reason: string; argv: string[][] }[];
    };
    expect(out.degraded, 'scope resolved, not degraded to full scope').toBe(
      false,
    );
    const reason = Object.fromEntries(
      out.scope.map((s) => [s.package, s.reason]),
    );
    expect(reason['@fix/cityville']).toBe('changed');
    expect(reason['@fix/studio'], 'dependent pulled in').toBe('dependent');
    const city = out.scope.find((s) => s.package === '@fix/cityville');
    expect(city!.argv).toEqual([['--filter', '@fix/cityville', 'verify']]);
  });

  it('clears a target that sets verifyCommands to null, rather than inheriting the block', () => {
    const root = repoWithStudioDependingOnCityville();
    editHouseConfig(root, (config) => {
      const targets = (config.targets ?? []) as {
        packageName?: string;
        verifyCommands?: string[] | null;
      }[];
      const city = targets.find((t) => t.packageName === '@fix/cityville');
      city!.verifyCommands = null;
    });
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );

    const r = runScript(root, SCRIPT, { args: ['--json'] });

    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as {
      scope: { package: string; argv: string[][] }[];
    };
    const city = out.scope.find((s) => s.package === '@fix/cityville');
    expect(city?.package, r.stdout).toBe('@fix/cityville');
    expect(city!.argv).toEqual([]);
  });
});

describe('verify-changed.mjs --run', () => {
  let root: string;

  beforeEach(() => {
    root = repoWithStudioDependingOnCityville();
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );
  });

  it('emits a PASS line per package and exits 0 when the runner passes', () => {
    useStubVerifyRunner(root, { fail: false });
    const r = runScript(root, SCRIPT, { args: ['--run'] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/@fix\/cityville: PASS/);
    expect(r.stdout).toMatch(/@fix\/studio: PASS/);
    const calls = readFileSync(join(root, 'runner-calls.txt'), 'utf8')
      .trim()
      .split('\n')
      .sort();
    expect(calls).toEqual([
      '--filter @fix/cityville verify',
      '--filter @fix/studio verify',
    ]);
  });

  it('emits a FAIL line and exits 2 with a trimmed residue tail when the runner fails', () => {
    useStubVerifyRunner(root, { fail: true });
    const r = runScript(root, SCRIPT, { args: ['--run'] });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(/@fix\/cityville: FAIL \(verify\)/);
    expect(r.stderr).toMatch(/TS2322/);
  });

  it('exits 0 with "nothing to verify" when there are no changes', () => {
    const freshRoot = repoWithStudioDependingOnCityville();
    const r = runScript(freshRoot, SCRIPT, { args: ['--run'] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/nothing to verify/);
  });

  it('names the verify block to configure when none exists, instead of running a script the repo never had', () => {
    const bareRoot = repoWithStudioDependingOnCityville();
    editHouseConfig(bareRoot, (config) => {
      delete config.verify;
    });
    appendFileSync(
      join(bareRoot, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );

    const r = runScript(bareRoot, SCRIPT, { args: ['--run'] });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/no "verify" block configured/);
    expect(r.stdout).toMatch(/\.claude\/houserules\.config\.json/);
  });
});
