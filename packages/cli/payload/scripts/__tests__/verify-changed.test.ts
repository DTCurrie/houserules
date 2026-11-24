import { beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { ConfigTarget } from '@houserules/payload/config';
import type { WorkspacePackage } from '@houserules/payload/workspaces';
import type { BudgetSignals } from '@houserules/payload/resource-budget';
import {
  budgetShareEnv,
  fullScopeEntries,
  jobEdges,
  jobPlan,
  nextJob,
  planLines,
  resolveScope,
  resolveVerifyCommands,
  spawnTimedOut,
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

function useStubVerifyRunner(
  root: string,
  {
    fail = false,
    hangMs,
    timeoutMs,
  }: { fail?: boolean; hangMs?: number; timeoutMs?: number } = {},
): void {
  const stub = stubRunner(root, { fail, failMessage: 'type error TS2322' });
  if (hangMs !== undefined)
    writeFileSync(
      stub,
      `#!/bin/sh\necho "$@" >> runner-calls.txt\necho started-before-cap >&2\nexec node -e "setTimeout(() => {}, ${hangMs})"\n`,
    );
  editHouseConfig(root, (config) => {
    const verify = config.verify as { runner?: string; timeoutMs?: number };
    verify.runner = './stub-runner.sh';
    if (timeoutMs !== undefined) verify.timeoutMs = timeoutMs;
  });
}

const SHARE_VARIABLES = [
  'VITEST_MAX_WORKERS',
  'WIREIT_PARALLEL',
  'pnpm_config_workspace_concurrency',
] as const;

/** Swaps the stub runner for one that records each share variable, or `unset`, per call. */
function useEnvRecordingRunner(root: string): void {
  useStubVerifyRunner(root);
  const lines = SHARE_VARIABLES.map(
    (name) => `echo "${name}=\${${name}-unset}" >> runner-env.txt`,
  );
  writeFileSync(
    join(root, 'stub-runner.sh'),
    `#!/bin/sh\n${lines.join('\n')}\nexit 0\n`,
  );
}

/** Installs a tool fragment that lists WIREIT_PARALLEL as a share variable. */
function useWireitFragment(root: string): void {
  mkdirSync(join(root, '.claude/extensions'), { recursive: true });
  writeFileSync(
    join(root, '.claude/extensions/wireit.json'),
    JSON.stringify({ shareVariables: ['WIREIT_PARALLEL'] }),
  );
}

/** The share variables the first recorded child saw, `unset` for an absent one. */
function recordedShare(root: string): Record<string, string> {
  const lines = readFileSync(join(root, 'runner-env.txt'), 'utf8')
    .trim()
    .split('\n')
    .slice(0, SHARE_VARIABLES.length);
  return Object.fromEntries(lines.map((line) => line.split('=')));
}

/**
 * Runs `args`, `--run` by default, with none of the share variables inherited from this test process,
 * so a wave's own share never leaks into the case, then applies `parentEnv`.
 */
function runVerifyWithParentEnv(
  root: string,
  parentEnv: Record<string, string> = {},
  args: string[] = ['--run'],
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_PATH;
  for (const name of SHARE_VARIABLES) delete env[name];
  return spawnSync(process.execPath, [join(root, SCRIPT), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...env, ...parentEnv },
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

    const lines = planLines(
      scope,
      'pnpm',
      '--filter',
      [],
      'main',
      false,
      'git',
    );

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

    const lines = planLines(scope, 'pnpm', '--filter', [], 'main', true, 'git');

    expect(lines[0]).toBe(
      'verify-changed: 1 package(s), FULL SCOPE (git/config unavailable)',
    );
  });

  it('omits the "+ N dependent" clause when nothing dependent is in scope', () => {
    const scope: ScopeEntry[] = [
      { package: '@fix/cityville', reason: 'changed', commands: [] },
    ];

    const lines = planLines(
      scope,
      'pnpm',
      '--filter',
      [],
      'main',
      false,
      'git',
    );

    expect(lines[0]).toBe(
      'verify-changed: 1 package(s) in scope (1 changed) vs base `main`',
    );
  });
});

describe('budgetShareEnv', () => {
  function fakeBudgetSignals(ncpu: number, load1: number): () => BudgetSignals {
    return () => ({ ncpu, load1, availableMemory: 0 });
  }

  it('gives a run alone on 18 cores the outer fan-out 4 and no vitest cap', () => {
    const env = budgetShareEnv({ PATH: '/bin' }, fakeBudgetSignals(18, 3), [
      'WIREIT_PARALLEL',
    ]);
    expect(env).toEqual({
      PATH: '/bin',
      WIREIT_PARALLEL: '4',
      pnpm_config_workspace_concurrency: '4',
    });
  });

  it('halves the fan-out to 2 when the load reaches the core count', () => {
    const env = budgetShareEnv({}, fakeBudgetSignals(18, 18), [
      'WIREIT_PARALLEL',
    ]);
    expect(env.WIREIT_PARALLEL).toBe('2');
    expect(env.pnpm_config_workspace_concurrency).toBe('2');
    expect(env).not.toHaveProperty('VITEST_MAX_WORKERS');
  });

  it('gives a 4-core machine the fan-out 5, its budget 16 over a vitest pool of 3', () => {
    const env = budgetShareEnv({}, fakeBudgetSignals(4, 0), [
      'WIREIT_PARALLEL',
    ]);
    expect(env.WIREIT_PARALLEL).toBe('5');
    expect(env.pnpm_config_workspace_concurrency).toBe('5');
  });

  it('passes a caller-set share through unchanged and fills only what is unset', () => {
    const parent = { VITEST_MAX_WORKERS: '8', WIREIT_PARALLEL: '1' };
    const env = budgetShareEnv(parent, fakeBudgetSignals(18, 3), [
      'WIREIT_PARALLEL',
    ]);
    expect(env).toEqual({
      VITEST_MAX_WORKERS: '8',
      WIREIT_PARALLEL: '1',
      pnpm_config_workspace_concurrency: '4',
    });
    expect(parent).toEqual({ VITEST_MAX_WORKERS: '8', WIREIT_PARALLEL: '1' });
  });

  it('sets no WIREIT_PARALLEL when no fragment lists a tool variable', () => {
    const env = budgetShareEnv({ PATH: '/bin' }, fakeBudgetSignals(18, 3), []);
    expect(env).toEqual({
      PATH: '/bin',
      pnpm_config_workspace_concurrency: '4',
    });
  });

  it('returns the parent environment unchanged when the signals cannot be read', () => {
    const parent = { PATH: '/bin' };
    const env = budgetShareEnv(parent, () => {
      throw new Error('availableParallelism unavailable');
    }, ['WIREIT_PARALLEL']);
    expect(env).toBe(parent);
    expect(env).toEqual({ PATH: '/bin' });
  });
});

describe('spawnTimedOut', () => {
  const etimedout = Object.assign(
    new Error('spawnSync ./stub-runner.sh ETIMEDOUT'),
    { code: 'ETIMEDOUT' },
  );

  it.each([
    {
      name: 'a capped step killed with an ETIMEDOUT error and SIGTERM',
      result: { error: etimedout, signal: 'SIGTERM' as const },
      cap: 3000,
      expected: true,
    },
    {
      name: 'a capped step carrying only the ETIMEDOUT error',
      result: { error: etimedout, signal: null },
      cap: 3000,
      expected: true,
    },
    {
      name: 'a capped step ended by a signal with no error',
      result: { signal: 'SIGKILL' as const },
      cap: 3000,
      expected: true,
    },
    {
      name: 'a capped step that exited nonzero on its own',
      result: { signal: null },
      cap: 3000,
      expected: false,
    },
    {
      name: 'an uncapped step ended by a signal',
      result: { signal: 'SIGTERM' as const },
      cap: undefined,
      expected: false,
    },
  ])(
    'classifies $name as timed out: $expected',
    ({ result, cap, expected }) => {
      expect(spawnTimedOut(result, cap)).toBe(expected);
    },
  );
});

describe('jobPlan', () => {
  const eighteenCores = (): BudgetSignals => ({
    ncpu: 18,
    load1: 3,
    availableMemory: 0,
  });

  it('runs 4 jobs on 18 cores, each child getting a fan-out of 1 and no vitest cap', () => {
    expect(
      jobPlan({ PATH: '/bin' }, eighteenCores, true, ['WIREIT_PARALLEL']),
    ).toEqual({
      limit: 4,
      childEnv: {
        PATH: '/bin',
        WIREIT_PARALLEL: '1',
        pnpm_config_workspace_concurrency: '1',
      },
    });
  });

  it('runs one job with the run-alone share when concurrent is false', () => {
    expect(
      jobPlan({ PATH: '/bin' }, eighteenCores, false, ['WIREIT_PARALLEL']),
    ).toEqual({
      limit: 1,
      childEnv: {
        PATH: '/bin',
        WIREIT_PARALLEL: '4',
        pnpm_config_workspace_concurrency: '4',
      },
    });
  });

  it('runs one job and passes the share through when the caller set VITEST_MAX_WORKERS', () => {
    expect(
      jobPlan({ VITEST_MAX_WORKERS: '8' }, eighteenCores, true, [
        'WIREIT_PARALLEL',
      ]),
    ).toEqual({
      limit: 1,
      childEnv: {
        VITEST_MAX_WORKERS: '8',
        WIREIT_PARALLEL: '4',
        pnpm_config_workspace_concurrency: '4',
      },
    });
  });

  it('runs one job when the caller set a tool variable', () => {
    const plan = jobPlan({ WIREIT_PARALLEL: '2' }, eighteenCores, true, [
      'WIREIT_PARALLEL',
    ]);
    expect(plan.limit).toBe(1);
    expect(plan.childEnv.WIREIT_PARALLEL).toBe('2');
  });

  it('adds no WIREIT_PARALLEL to the child env when the tool list is empty', () => {
    const plan = jobPlan({ PATH: '/bin' }, eighteenCores, true, []);
    expect(plan.limit).toBe(4);
    expect(plan.childEnv).not.toHaveProperty('WIREIT_PARALLEL');
  });

  it('runs one job with the parent environment as it is when the signals cannot be read', () => {
    const parent = { PATH: '/bin' };
    const plan = jobPlan(
      parent,
      () => {
        throw new Error('availableParallelism unavailable');
      },
      true,
      ['WIREIT_PARALLEL'],
    );
    expect(plan.limit).toBe(1);
    expect(plan.childEnv).toBe(parent);
  });
});

describe('jobEdges', () => {
  it('lists the in-scope packages a manifest names in any dependency field, dropping the rest', () => {
    const packages: WorkspacePackage[] = [
      pkg('core'),
      pkg('mid', { core: 'workspace:*' }),
      {
        ...pkg('outer'),
        pkg: {
          name: 'outer',
          devDependencies: { mid: 'workspace:*' },
          peerDependencies: { core: 'workspace:*' },
          optionalDependencies: { lone: 'workspace:*' },
        },
      },
      pkg('lone'),
    ];
    const scope: ScopeEntry[] = ['core', 'mid', 'outer'].map((name) => ({
      package: name,
      reason: 'changed',
    }));

    expect(jobEdges(scope, packages)).toEqual(
      new Map([
        ['core', []],
        ['mid', ['core']],
        ['outer', ['mid', 'core']],
      ]),
    );
  });

  it('makes a root entry depend on every other entry, however unrelated', () => {
    const scope: ScopeEntry[] = [
      { package: 'a', reason: 'changed' },
      { package: 'b', reason: 'dependent' },
      { package: 'top', reason: 'root' },
    ];

    expect(jobEdges(scope, [pkg('a'), pkg('b')])).toEqual(
      new Map([
        ['a', []],
        ['b', []],
        ['top', ['a', 'b']],
      ]),
    );
  });

  it('gives a single-package entry with no workspace manifest no edges', () => {
    expect(
      jobEdges([{ package: '.', reason: 'changed', single: true }], []),
    ).toEqual(new Map([['.', []]]));
  });
});

describe('nextJob', () => {
  it.each([
    {
      name: 'the first pending job in scope order when none has an edge',
      pending: ['a', 'b'],
      edges: { a: [], b: [] },
      exited: [],
      runningCount: 1,
      expected: 'a',
    },
    {
      name: 'a later job when the first waits on a dependency still running',
      pending: ['b', 'c'],
      edges: { b: ['a'], c: [] },
      exited: [],
      runningCount: 1,
      expected: 'c',
    },
    {
      name: 'a dependent once its dependency has exited',
      pending: ['b'],
      edges: { b: ['a'] },
      exited: ['a'],
      runningCount: 0,
      expected: 'b',
    },
    {
      name: 'nothing while every pending job waits on a running one',
      pending: ['b', 'c'],
      edges: { b: ['a'], c: ['a'] },
      exited: [],
      runningCount: 1,
      expected: undefined,
    },
    {
      name: 'the first pending job of a cycle when nothing is running',
      pending: ['a', 'b'],
      edges: { a: ['b'], b: ['a'] },
      exited: [],
      runningCount: 0,
      expected: 'a',
    },
  ])('starts $name', ({ pending, edges, exited, runningCount, expected }) => {
    expect(
      nextJob(
        pending,
        new Map(Object.entries(edges)),
        new Set(exited),
        runningCount,
      ),
    ).toBe(expected);
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

describe('verify-changed.mjs with verify.rootCommands', () => {
  interface RootScope {
    scope: {
      package: string;
      reason: string;
      commands: string[];
      argv: string[][];
    }[];
  }

  function setRootCommands(root: string, rootCommands: string[]): void {
    editHouseConfig(root, (config) => {
      (config.verify as { rootCommands?: string[] }).rootCommands =
        rootCommands;
    });
  }

  const ROOT_ID = '<root>';

  function renameRootPackage(root: string, name: string): void {
    const path = join(root, 'package.json');
    const manifest = readJson<Record<string, unknown>>(path);
    manifest['name'] = name;
    writeFileSync(path, JSON.stringify(manifest, null, 2));
  }

  function scopeOf(root: string): RootScope['scope'] {
    const r = runScript(root, SCRIPT, { args: ['--json'] });
    expect(r.status, r.stderr).toBe(0);
    return (JSON.parse(r.stdout) as RootScope).scope;
  }

  it('lists a root entry last, with the root commands and no filter flag, after a diff under one package', () => {
    const root = repoWithStudioDependingOnCityville();
    setRootCommands(root, ['verify:knip']);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );

    const scope = scopeOf(root);

    expect(scope.map((s) => s.package)).toEqual([
      '@fix/cityville',
      '@fix/studio',
      ROOT_ID,
    ]);
    expect(scope[2]).toMatchObject({
      reason: 'root',
      commands: ['verify:knip'],
      argv: [['run', 'verify:knip']],
    });
  });

  it('keeps a package and the root entry apart when the root package.json carries that package name', () => {
    const root = repoWithStudioDependingOnCityville();
    useStubVerifyRunner(root);
    renameRootPackage(root, '@fix/cityville');
    setRootCommands(root, ['verify:knip']);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );

    const scope = scopeOf(root);
    const r = runScript(root, SCRIPT, { args: ['--run'] });

    expect(scope.map((s) => [s.package, s.reason])).toEqual([
      ['@fix/cityville', 'changed'],
      ['@fix/studio', 'dependent'],
      [ROOT_ID, 'root'],
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(
      readFileSync(join(root, 'runner-calls.txt'), 'utf8').trim().split('\n'),
    ).toEqual([
      '--filter @fix/cityville verify',
      '--filter @fix/studio verify',
      'run verify:knip',
    ]);
  });

  it('adds no root entry when rootCommands is unset', () => {
    const root = repoWithStudioDependingOnCityville();
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );

    expect(scopeOf(root).map((s) => s.reason)).toEqual([
      'changed',
      'dependent',
    ]);
  });

  it('adds no root entry when rootCommands is empty', () => {
    const root = repoWithStudioDependingOnCityville();
    setRootCommands(root, []);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );

    expect(scopeOf(root).map((s) => s.reason)).toEqual([
      'changed',
      'dependent',
    ]);
  });

  it('yields the root entry alone for a change to a root-level file', () => {
    const root = repoWithStudioDependingOnCityville();
    setRootCommands(root, ['verify']);
    writeFileSync(join(root, 'notes.txt'), 'x\n');

    const scope = scopeOf(root);

    expect(scope.map((s) => [s.package, s.reason])).toEqual([
      [ROOT_ID, 'root'],
    ]);
  });

  it('adds the root entry last under --full', () => {
    const root = repoWithStudioDependingOnCityville();
    setRootCommands(root, ['verify']);

    const r = runScript(root, SCRIPT, { args: ['--json', '--full'] });

    expect(r.status, r.stderr).toBe(0);
    const reasons = (JSON.parse(r.stdout) as RootScope).scope.map(
      (s) => s.reason,
    );
    expect(reasons.at(-1)).toBe('root');
    expect(reasons.filter((reason) => reason === 'root')).toHaveLength(1);
  });

  it('prints the root entry with a [root] reason in the plan', () => {
    const root = repoWithStudioDependingOnCityville();
    setRootCommands(root, ['verify:knip']);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );

    const r = runScript(root, SCRIPT);

    expect(r.stdout).toContain(`${ROOT_ID}  [root]  `);
  });

  it('runs the root commands after every package job and prints the root verdict last', () => {
    const root = repoWithStudioDependingOnCityville();
    useStubVerifyRunner(root);
    setRootCommands(root, ['verify:knip']);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );

    const r = runScript(root, SCRIPT, { args: ['--run'] });

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split('\n').at(-1)).toBe(`${ROOT_ID}: PASS`);
    expect(
      readFileSync(join(root, 'runner-calls.txt'), 'utf8').trim().split('\n'),
    ).toEqual([
      '--filter @fix/cityville verify',
      '--filter @fix/studio verify',
      'run verify:knip',
    ]);
  });
});

interface ScopeJson {
  source: string;
  degraded: boolean;
  scope: { package: string; reason: string; argv: string[][] }[];
}

function runWithoutGit(root: string, args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_DIR: join(root, 'no-such-git-dir'),
  };
  delete env.NODE_PATH;
  return spawnSync(process.execPath, [join(root, SCRIPT), ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
}

describe('verify-changed.mjs --paths', () => {
  let root: string;

  beforeEach(() => {
    root = repoWithStudioDependingOnCityville();
  });

  it('plans the owning package and its dependents only, from the given paths', () => {
    const r = runScript(root, SCRIPT, {
      args: [
        '--json',
        '--paths',
        'games/cityville/src/game.ts,games/cityville/src/other.ts',
      ],
    });

    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as ScopeJson;
    expect(out.source).toBe('paths');
    expect(
      Object.fromEntries(out.scope.map((s) => [s.package, s.reason])),
    ).toEqual({ '@fix/cityville': 'changed', '@fix/studio': 'dependent' });
  });

  it('leaves out a package that neither contains a path nor depends on one', () => {
    const r = runScript(root, SCRIPT, {
      args: ['--json', '--paths', 'apps/studio/src/a.ts,apps/studio/src/b.ts'],
    });

    const out = JSON.parse(r.stdout) as ScopeJson;
    expect(out.scope.map((s) => s.package)).toEqual(['@fix/studio']);
  });

  it('exits 1 naming a path that no package contains', () => {
    const r = runScript(root, SCRIPT, {
      args: ['--json', '--paths', 'games/cityville/src/game.ts,stray/file.ts'],
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      'verify-changed: --paths stray/file.ts is outside every package.\n',
    );
  });

  it('adds the package-wide Note line to the plan preview', () => {
    const withPaths = runScript(root, SCRIPT, {
      args: ['--paths', 'games/cityville/src/game.ts'],
    });
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const y = 2;\n',
    );
    const withoutPaths = runScript(root, SCRIPT);

    expect(withPaths.stdout).toContain(
      "Note: --paths selects packages, not tests. Each selected package still runs its steps package-wide, so a run can test a sibling's in-progress edit in the same package.\n",
    );
    expect(withoutPaths.stdout).not.toContain('Note: --paths');
  });

  it('exits 1 when combined with --full', () => {
    const r = runScript(root, SCRIPT, {
      args: ['--paths', 'games/cityville/src/game.ts', '--full'],
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toBe(
      'verify-changed: --paths and --full cannot be combined.\n',
    );
  });

  describe('with verify.relatedCommand', () => {
    function setRelatedCommand(template: string | undefined): void {
      editHouseConfig(root, (config) => {
        const verify = config.verify as {
          commands?: string[];
          relatedCommand?: string | undefined;
        };
        verify.commands = ['check', 'test'];
        verify.relatedCommand = template;
      });
    }

    function scopeFor(): ScopeJson['scope'] {
      const r = runScript(root, SCRIPT, {
        args: [
          '--json',
          '--paths',
          'games/cityville/src/game.ts,games/cityville/src/other.ts',
        ],
      });
      return (JSON.parse(r.stdout) as ScopeJson).scope;
    }

    it('replaces only the changed package test step, with the prefix stripped from each path', () => {
      setRelatedCommand('run-related --bail {files}');

      const scope = scopeFor();

      expect(scope.find((s) => s.package === '@fix/cityville')!.argv).toEqual([
        ['--filter', '@fix/cityville', 'check'],
        [
          '--filter',
          '@fix/cityville',
          'run-related',
          '--bail',
          'src/game.ts',
          'src/other.ts',
        ],
      ]);
      expect(scope.find((s) => s.package === '@fix/studio')!.argv).toEqual([
        ['--filter', '@fix/studio', 'check'],
        ['--filter', '@fix/studio', 'test'],
      ]);
    });

    it('appends the paths when the template has no {files}', () => {
      setRelatedCommand('run-related');

      const city = scopeFor().find((s) => s.package === '@fix/cityville');

      expect(city!.argv[1]).toEqual([
        '--filter',
        '@fix/cityville',
        'run-related',
        'src/game.ts',
        'src/other.ts',
      ]);
    });

    it('keeps the package-level test step when the key is unset', () => {
      setRelatedCommand(undefined);

      const city = scopeFor().find((s) => s.package === '@fix/cityville');

      expect(city!.argv[1]).toEqual(['--filter', '@fix/cityville', 'test']);
    });
  });
});

describe('verify-changed.mjs --full', () => {
  it('plans every workspace package as full-scope without asking git', () => {
    const root = repoWithStudioDependingOnCityville();

    const r = runWithoutGit(root, ['--json', '--full']);

    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as ScopeJson;
    expect(out.source).toBe('full');
    expect(out.degraded).toBe(false);
    expect(out.scope.map((s) => [s.package, s.reason]).sort()).toEqual([
      ['@fix/cityville', 'full-scope'],
      ['@fix/studio', 'full-scope'],
    ]);
  });

  it('degrades to full scope under a failing git when --full is absent', () => {
    const root = repoWithStudioDependingOnCityville();

    const r = runWithoutGit(root, ['--json']);

    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as ScopeJson;
    expect(out.source).toBe('git');
    expect(out.degraded).toBe(true);
    expect(out.scope.map((s) => [s.package, s.reason]).sort()).toEqual([
      ['@fix/cityville', 'full-scope'],
      ['@fix/studio', 'full-scope'],
    ]);
  });

  it('words the plan summary as FULL SCOPE under a failing git', () => {
    const root = repoWithStudioDependingOnCityville();

    const r = runWithoutGit(root, []);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(
      'verify-changed: 2 package(s), FULL SCOPE (git/config unavailable)\n',
    );
  });

  it('words the plan summary as --full, not as unavailable git', () => {
    const root = repoWithStudioDependingOnCityville();

    const r = runScript(root, SCRIPT, { args: ['--full'] });

    expect(r.stdout).toContain(
      'verify-changed: 2 package(s), FULL SCOPE (--full)\n',
    );
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

  it('reports a step that outlives verify.timeoutMs as timed out, keeps its output, and exits 2', () => {
    useStubVerifyRunner(root, { hangMs: 10_000, timeoutMs: 1000 });
    const r = runScript(root, SCRIPT, { args: ['--run'] });
    expect(r.status).toBe(2);
    expect(r.stdout).toMatch(
      /@fix\/cityville: FAIL \(verify, timed out after 1s\)/,
    );
    expect(r.stderr).toMatch(/started-before-cap/);
    expect(readFileSync(join(root, 'runner-calls.txt'), 'utf8')).toMatch(
      /--filter @fix\/cityville verify/,
    );
  });

  it('leaves a slow step uncapped when verify.timeoutMs is unset', () => {
    useStubVerifyRunner(root, { hangMs: 300 });
    const r = runScript(root, SCRIPT, { args: ['--run'] });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/@fix\/cityville: PASS/);
  });

  it('passes a run alone its outer fan-out and no vitest cap', () => {
    useEnvRecordingRunner(root);
    useWireitFragment(root);
    const r = runVerifyWithParentEnv(root);
    expect(r.status, r.stderr).toBe(0);
    const share = recordedShare(root);
    expect(share.VITEST_MAX_WORKERS).toBe('unset');
    expect(share.WIREIT_PARALLEL).toMatch(/^[1-9]\d*$/);
    expect(share.pnpm_config_workspace_concurrency).toBe(share.WIREIT_PARALLEL);
  });

  it('passes a share the caller set to the child unchanged', () => {
    useEnvRecordingRunner(root);
    useWireitFragment(root);
    const r = runVerifyWithParentEnv(root, {
      VITEST_MAX_WORKERS: '8',
      WIREIT_PARALLEL: '1',
    });
    expect(r.status, r.stderr).toBe(0);
    const share = recordedShare(root);
    expect(share.VITEST_MAX_WORKERS).toBe('8');
    expect(share.WIREIT_PARALLEL).toBe('1');
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

  describe('a target with verifyCommands: null', () => {
    beforeEach(() => {
      useStubVerifyRunner(root);
      editHouseConfig(root, (config) => {
        const targets = (config.targets ?? []) as {
          packageName?: string;
          verifyCommands?: string[] | null;
        }[];
        targets.find(
          (t) => t.packageName === '@fix/cityville',
        )!.verifyCommands = null;
      });
    });

    it('prints SKIPPED instead of PASS under --run and exits 0', () => {
      const r = runScript(root, SCRIPT, { args: ['--run'] });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(
        /@fix\/cityville: SKIPPED \(no verify commands\)/,
      );
      expect(r.stdout).not.toMatch(/@fix\/cityville: PASS/);
      expect(r.stdout).toMatch(/@fix\/studio: PASS/);
    });

    it('carries the SKIPPED wording in the plan output', () => {
      const r = runScript(root, SCRIPT);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(
        /@fix\/cityville\s+\[changed\]\s+SKIPPED \(no verify commands\)/,
      );
    });
  });
});

interface JobSpan {
  start: number;
  end: number;
}

/**
 * Swaps the stub runner for one that appends `start <pkg> <ms>` and `end <pkg> <ms>` to
 * `timeline.txt` around a wait of `jobs[pkg].ms`, then fails when `jobs[pkg].fail` is set.
 */
function useTimelineRunner(
  root: string,
  jobs: Record<string, { ms: number; fail?: boolean }>,
  { concurrent }: { concurrent?: boolean } = {},
): void {
  useStubVerifyRunner(root);
  const timeline = join(root, 'timeline.txt');
  writeFileSync(
    join(root, 'stub-timeline.mjs'),
    [
      "import { appendFileSync } from 'node:fs';",
      'const name = process.argv[3];',
      `const { ms, fail } = ${JSON.stringify(jobs)}[name];`,
      `appendFileSync(${JSON.stringify(timeline)}, \`start \${name} \${Date.now()}\\n\`);`,
      'setTimeout(() => {',
      `  appendFileSync(${JSON.stringify(timeline)}, \`end \${name} \${Date.now()}\\n\`);`,
      '  if (fail) {',
      '    process.stderr.write(`${name} broke: type error TS2322\\n`);',
      '    process.exitCode = 1;',
      '  }',
      '}, ms);',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'stub-runner.sh'),
    `#!/bin/sh\nexec node ${JSON.stringify(join(root, 'stub-timeline.mjs'))} "$@"\n`,
  );
  if (concurrent !== undefined)
    editHouseConfig(root, (config) => {
      (config.verify as { concurrent?: boolean }).concurrent = concurrent;
    });
}

/** Each package's recorded start and end, in epoch milliseconds. */
function readTimeline(root: string): Record<string, JobSpan> {
  const spans: Record<string, JobSpan> = {};
  for (const line of readFileSync(join(root, 'timeline.txt'), 'utf8')
    .trim()
    .split('\n')) {
    const [event, name, ms] = line.split(' ') as [
      'start' | 'end',
      string,
      string,
    ];
    spans[name] = { ...spans[name], [event]: Number(ms) } as JobSpan;
  }
  return spans;
}

function repoWithIndependentPackages(): string {
  return useInstalledRepo('pnpm-monorepo', { modules: 'verify-changed' });
}

/** The fixture plus `toolkits/shared` as `@fix/shared`, which cityville and studio both depend on. */
function repoWithSharedDependency(): string {
  const root = useInstalledRepo('pnpm-monorepo', { modules: 'verify-changed' });
  mkdirSync(join(root, 'toolkits/shared'), { recursive: true });
  writeFileSync(
    join(root, 'toolkits/shared/package.json'),
    JSON.stringify({ name: '@fix/shared', private: true }, null, 2),
  );
  for (const dir of ['games/cityville', 'apps/studio']) {
    const path = join(root, dir, 'package.json');
    const manifest = readJson<CityvillePackageJson>(path);
    manifest.dependencies = { '@fix/shared': 'workspace:*' };
    writeFileSync(path, JSON.stringify(manifest, null, 2));
  }
  return root;
}

const RUN_FULL = ['--run', '--full'];

describe('verify-changed.mjs --run jobs', () => {
  it('starts two packages with no dependency edge between them together', () => {
    const root = repoWithIndependentPackages();
    useTimelineRunner(root, {
      '@fix/cityville': { ms: 400 },
      '@fix/studio': { ms: 400 },
    });

    const r = runVerifyWithParentEnv(root, {}, RUN_FULL);

    expect(r.status, r.stderr).toBe(0);
    const spans = readTimeline(root);
    expect(
      spans['@fix/studio']!.start,
      'studio should start before cityville ends',
    ).toBeLessThan(spans['@fix/cityville']!.end);
  });

  it('starts a dependent only after the job of the package it depends on exits', () => {
    const root = repoWithStudioDependingOnCityville();
    useTimelineRunner(root, {
      '@fix/cityville': { ms: 400 },
      '@fix/studio': { ms: 100 },
    });

    const r = runVerifyWithParentEnv(root, {}, RUN_FULL);

    expect(r.status, r.stderr).toBe(0);
    const spans = readTimeline(root);
    expect(spans['@fix/studio']!.start).toBeGreaterThanOrEqual(
      spans['@fix/cityville']!.end,
    );
  });

  it('runs one job at a time in scope order when verify.concurrent is false', () => {
    const root = repoWithIndependentPackages();
    useTimelineRunner(
      root,
      { '@fix/cityville': { ms: 400 }, '@fix/studio': { ms: 100 } },
      { concurrent: false },
    );

    const r = runVerifyWithParentEnv(root, {}, RUN_FULL);

    expect(r.status, r.stderr).toBe(0);
    const spans = readTimeline(root);
    expect(spans['@fix/studio']!.start).toBeGreaterThanOrEqual(
      spans['@fix/cityville']!.end,
    );
  });

  it('a package two in-scope packages both depend on exits before either dependent starts, so no two jobs write its build output at once', () => {
    const root = repoWithSharedDependency();
    useTimelineRunner(root, {
      '@fix/shared': { ms: 400 },
      '@fix/cityville': { ms: 100 },
      '@fix/studio': { ms: 100 },
    });

    const r = runVerifyWithParentEnv(root, {}, RUN_FULL);

    expect(r.status, r.stderr).toBe(0);
    const spans = readTimeline(root);
    expect(
      Math.min(spans['@fix/cityville']!.start, spans['@fix/studio']!.start),
    ).toBeGreaterThanOrEqual(spans['@fix/shared']!.end);
  });

  it('prints every verdict and residue block in scope order when the first job in scope finishes last', () => {
    const root = repoWithIndependentPackages();
    useTimelineRunner(root, {
      '@fix/cityville': { ms: 800, fail: true },
      '@fix/studio': { ms: 100 },
    });

    const r = runVerifyWithParentEnv(root, {}, RUN_FULL);

    const spans = readTimeline(root);
    expect(
      spans['@fix/studio']!.end,
      'studio must finish first, or this case cannot tell scope order from finish order',
    ).toBeLessThan(spans['@fix/cityville']!.end);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('@fix/cityville: FAIL (verify)\n@fix/studio: PASS\n');
    expect(r.stderr).toBe(
      '\n--- @fix/cityville :: verify ---\n@fix/cityville broke: type error TS2322\n\n',
    );
  });
});
