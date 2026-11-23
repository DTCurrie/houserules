import { beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigTarget } from '@houserules/payload/config';
import type { WorkspacePackage } from '@houserules/payload/workspaces';
import type { BudgetSignals } from '@houserules/payload/resource-budget';
import {
  budgetShareEnv,
  fullScopeEntries,
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

/** The share variables the first recorded child saw, `unset` for an absent one. */
function recordedShare(root: string): Record<string, string> {
  const lines = readFileSync(join(root, 'runner-env.txt'), 'utf8')
    .trim()
    .split('\n')
    .slice(0, SHARE_VARIABLES.length);
  return Object.fromEntries(lines.map((line) => line.split('=')));
}

/**
 * Runs `--run` with none of the share variables inherited from this test process,
 * so a wave's own share never leaks into the case, then applies `parentEnv`.
 */
function runVerifyWithParentEnv(
  root: string,
  parentEnv: Record<string, string> = {},
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_PATH;
  for (const name of SHARE_VARIABLES) delete env[name];
  return spawnSync(process.execPath, [join(root, SCRIPT), '--run'], {
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

describe('budgetShareEnv', () => {
  function fakeBudgetSignals(ncpu: number, load1: number): () => BudgetSignals {
    return () => ({ ncpu, load1, availableMemory: 0 });
  }

  it('gives a run alone on 18 cores the outer fan-out 4 and no vitest cap', () => {
    const env = budgetShareEnv({ PATH: '/bin' }, fakeBudgetSignals(18, 3));
    expect(env).toEqual({
      PATH: '/bin',
      WIREIT_PARALLEL: '4',
      pnpm_config_workspace_concurrency: '4',
    });
  });

  it('halves the fan-out to 2 when the load reaches the core count', () => {
    const env = budgetShareEnv({}, fakeBudgetSignals(18, 18));
    expect(env.WIREIT_PARALLEL).toBe('2');
    expect(env.pnpm_config_workspace_concurrency).toBe('2');
    expect(env).not.toHaveProperty('VITEST_MAX_WORKERS');
  });

  it('gives a 4-core machine the fan-out 5, its budget 16 over a vitest pool of 3', () => {
    const env = budgetShareEnv({}, fakeBudgetSignals(4, 0));
    expect(env.WIREIT_PARALLEL).toBe('5');
    expect(env.pnpm_config_workspace_concurrency).toBe('5');
  });

  it('passes a caller-set share through unchanged and fills only what is unset', () => {
    const parent = { VITEST_MAX_WORKERS: '8', WIREIT_PARALLEL: '1' };
    const env = budgetShareEnv(parent, fakeBudgetSignals(18, 3));
    expect(env).toEqual({
      VITEST_MAX_WORKERS: '8',
      WIREIT_PARALLEL: '1',
      pnpm_config_workspace_concurrency: '4',
    });
    expect(parent).toEqual({ VITEST_MAX_WORKERS: '8', WIREIT_PARALLEL: '1' });
  });

  it('returns the parent environment unchanged when the signals cannot be read', () => {
    const parent = { PATH: '/bin' };
    const env = budgetShareEnv(parent, () => {
      throw new Error('availableParallelism unavailable');
    });
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
    const r = runVerifyWithParentEnv(root);
    expect(r.status, r.stderr).toBe(0);
    const share = recordedShare(root);
    expect(share.VITEST_MAX_WORKERS).toBe('unset');
    expect(share.WIREIT_PARALLEL).toMatch(/^[1-9]\d*$/);
    expect(share.pnpm_config_workspace_concurrency).toBe(share.WIREIT_PARALLEL);
  });

  it('passes a share the caller set to the child unchanged', () => {
    useEnvRecordingRunner(root);
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
