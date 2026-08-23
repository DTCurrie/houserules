import { beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';
import { stubRunner } from '#test/runner-stub';
import { editHouseConfig, readJson } from '#test/installed-tree';

interface CityvillePackageJson {
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

const SCRIPT = '.claude/scripts/verify-changed.mjs';

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
    expect(out.degraded).toBe(false);
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
