import { beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { HouseConfig } from '@houserules/payload/config';
import {
  affectedPackages,
  fixArgs,
  gatePasses,
  planFixSteps,
  plannedSteps,
  resolveFixSettings,
  type FixSettings,
} from '../lint-format-fix.mjs';
import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import {
  editHouseConfig,
  type InstalledHouseConfig,
} from '#test/installed-tree';
import { recordedCalls, stubRunner } from '#test/runner-stub';

const SCRIPT = '.claude/scripts/lint-format-fix.mjs';

function baseConfig(overrides: Partial<HouseConfig> = {}): HouseConfig {
  return {
    targets: [
      {
        name: 'cityville',
        pathPrefix: 'games/cityville/',
        packageName: '@fix/cityville',
      },
      {
        name: 'studio',
        pathPrefix: 'apps/studio/',
        packageName: '@fix/studio',
      },
    ],
    ...overrides,
  };
}

function setRunner(
  root: string,
  fixOverrides: Record<string, unknown> = {},
): void {
  editHouseConfig(root, (config: InstalledHouseConfig) => {
    config.fix = {
      runner: './stub-runner.sh',
      filterFlag: '--filter',
      runScriptPrefix: ['run'],
      commands: ['lint:fix', 'format:fix'],
      ...fixOverrides,
    };
  });
}

describe('resolveFixSettings', () => {
  it('defaults to pnpm, --filter, and no root run when the config carries no fix block', () => {
    const settings = resolveFixSettings(baseConfig());

    expect(settings.runner).toBe('pnpm');
    expect(settings.filterFlag).toBe('--filter');
    expect(
      settings.runsAtRoot,
      'runsAtRoot false with the default filterFlag',
    ).toBe(false);
    expect(settings.runPrefix).toEqual([]);
    expect(settings.commandExtensions).toEqual({});
    expect(settings.onSubagentStop, 'onSubagentStop defaults off').toBe(false);
  });

  it('falls back to config.packageManager when fix.runner is unset', () => {
    const settings = resolveFixSettings(baseConfig({ packageManager: 'npm' }));

    expect(settings.runner).toBe('npm');
  });

  it('reads runsAtRoot from an empty fix.filterFlag', () => {
    const settings = resolveFixSettings(
      baseConfig({ fix: { filterFlag: '' } }),
    );

    expect(
      settings.runsAtRoot,
      'runsAtRoot true with an empty filterFlag',
    ).toBe(true);
  });

  it('reads fix.onSubagentStop through to the resolved settings', () => {
    const settings = resolveFixSettings(
      baseConfig({ fix: { onSubagentStop: true } }),
    );

    expect(
      settings.onSubagentStop,
      'onSubagentStop reflects fix.onSubagentStop',
    ).toBe(true);
  });

  it('resolves each target to its own fixCommands override', () => {
    const settings = resolveFixSettings(
      baseConfig({
        targets: [
          {
            name: 'cityville',
            pathPrefix: 'games/cityville/',
            packageName: '@fix/cityville',
            fixCommands: ['custom:fix'],
          },
        ],
      }),
    );

    expect(settings.packageByPath).toEqual([
      {
        prefix: 'games/cityville/',
        name: '@fix/cityville',
        commands: ['custom:fix'],
      },
    ]);
  });

  it('resolves a target with fixCommands: null to no commands at all', () => {
    const settings = resolveFixSettings(
      baseConfig({
        targets: [
          {
            name: 'cityville',
            pathPrefix: 'games/cityville/',
            packageName: '@fix/cityville',
            fixCommands: null,
          },
        ],
      }),
    );

    expect(settings.packageByPath[0]?.commands).toEqual([]);
  });

  it('matches the default lintable extensions and rejects one outside them', () => {
    const settings = resolveFixSettings(baseConfig());

    expect(
      settings.lintableExtRe.test('src/game.ts'),
      'src/game.ts matches the default lintable extensions',
    ).toBe(true);
    expect(
      settings.lintableExtRe.test('README.lock'),
      'README.lock is not a lintable extension',
    ).toBe(false);
  });

  it('matches the default generated-file pattern for CHANGELOG.md and BACKLOG.md', () => {
    const settings = resolveFixSettings(baseConfig());

    expect(
      settings.generatedFileRe.test('/packages/cli/CHANGELOG.md'),
      'CHANGELOG.md is a generated file',
    ).toBe(true);
    expect(
      settings.generatedFileRe.test('/src/game.ts'),
      'src/game.ts is not a generated file',
    ).toBe(false);
  });
});

describe('gatePasses', () => {
  it('passes an ungated command regardless of the changed extensions', () => {
    expect(
      gatePasses('lint:fix', new Set(['md']), {}),
      'an ungated command always passes',
    ).toBe(true);
  });

  it('passes a gated command when a changed extension is in its allow list', () => {
    const passes = gatePasses('lint:fix', new Set(['ts']), {
      'lint:fix': ['ts', 'tsx'],
    });

    expect(passes, 'lint:fix passes since ts is in its allow list').toBe(true);
  });

  it('fails a gated command when no changed extension is in its allow list', () => {
    const passes = gatePasses('lint:fix', new Set(['md']), {
      'lint:fix': ['ts', 'tsx'],
    });

    expect(passes, 'lint:fix fails since md is not in its allow list').toBe(
      false,
    );
  });
});

describe('affectedPackages', () => {
  const settings: FixSettings = resolveFixSettings(baseConfig());

  it('maps a changed path to its target package and records the extension', () => {
    expect(affectedPackages(['games/cityville/src/game.ts'], settings)).toEqual(
      [['@fix/cityville', ['lint:fix', 'format:fix'], new Set(['ts'])]],
    );
  });

  it('drops a path outside the default lintable extensions', () => {
    expect(affectedPackages(['games/cityville/README.lock'], settings)).toEqual(
      [],
    );
  });

  it('drops a generated file even when it carries a lintable extension', () => {
    expect(affectedPackages(['packages/cli/CHANGELOG.md'], settings)).toEqual(
      [],
    );
  });

  it('drops a path matching no configured target', () => {
    expect(affectedPackages(['unmapped/dir/file.ts'], settings)).toEqual([]);
  });
});

describe('plannedSteps', () => {
  it('emits one step per package command when the commands run per package', () => {
    const pkgs: [string, string[], Set<string>][] = [
      ['@fix/cityville', ['lint:fix'], new Set(['ts'])],
    ];

    expect(plannedSteps(pkgs, false)).toEqual([
      ['@fix/cityville', 'lint:fix', new Set(['ts'])],
    ]);
  });

  it('collapses the same script across two packages into one root step with the union of extensions', () => {
    const pkgs: [string, string[], Set<string>][] = [
      ['@fix/cityville', ['lint:fix'], new Set(['ts'])],
      ['@fix/studio', ['lint:fix'], new Set(['md'])],
    ];

    expect(plannedSteps(pkgs, true)).toEqual([
      ['(root)', 'lint:fix', new Set(['ts', 'md'])],
    ]);
  });
});

describe('fixArgs', () => {
  it('puts the package after the filter flag when one is set', () => {
    expect(fixArgs('@fix/cityville', 'lint:fix', '--filter', [])).toEqual([
      '--filter',
      '@fix/cityville',
      'lint:fix',
    ]);
  });

  it('drops the package name and uses the run prefix when the filter flag is empty', () => {
    expect(fixArgs('(root)', 'lint:fix', '', ['run'])).toEqual([
      'run',
      'lint:fix',
    ]);
  });
});

describe('planFixSteps', () => {
  it('resolves a changed file to its package’s fix commands', () => {
    const settings = resolveFixSettings(baseConfig());

    expect(planFixSteps(['games/cityville/src/game.ts'], settings)).toEqual([
      ['@fix/cityville', 'lint:fix'],
      ['@fix/cityville', 'format:fix'],
    ]);
  });

  it('drops a step gated to extensions the change did not touch, keeping an ungated sibling', () => {
    const settings = resolveFixSettings(
      baseConfig({ fix: { commandExtensions: { 'lint:fix': ['md'] } } }),
    );

    expect(planFixSteps(['games/cityville/src/game.ts'], settings)).toEqual([
      ['@fix/cityville', 'format:fix'],
    ]);
  });

  it('returns no steps for an empty file list', () => {
    const settings = resolveFixSettings(baseConfig());

    expect(planFixSteps([], settings)).toEqual([]);
  });
});

describe('lint-format-fix.mjs on a changed package in a monorepo', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    stubRunner(root);
    setRunner(root);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );
  });

  it('invokes the runner once with --filter <pkg> using the target’s fixCommands override', () => {
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status, r.stderr).toBe(0);
    expect(recordedCalls(root)).toEqual(['--filter @fix/cityville fix']);
  });
});

describe('lint-format-fix.mjs when the runner fails', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    stubRunner(root, { fail: true });
    setRunner(root);
    appendFileSync(
      join(root, 'apps/studio/src/main.ts'),
      'export const y = 9;\n',
    );
  });

  it('exits 2 with a trimmed residue tail on stderr', () => {
    const r = runScript(root, SCRIPT, { input: '{}' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/residual issues/);
    expect(r.stderr).toMatch(/unfixable problem/);
  });

  it('exits 0 when stop_hook_active short-circuits a repeat run', () => {
    const r = runScript(root, SCRIPT, { input: '{"stop_hook_active":true}' });
    expect(r.status).toBe(0);
  });
});

describe('lint-format-fix.mjs on SubagentStop', () => {
  let root: string;
  let calls: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    calls = join(root, 'runner-calls.txt');
    stubRunner(root);
    setRunner(root);
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const x = 9;\n',
    );
  });

  it('is a no-op by default, since parallel workers would each fix every changed package at once and clobber siblings mid-edit', () => {
    const sub = '{"hook_event_name":"SubagentStop"}';
    expect(runScript(root, SCRIPT, { input: sub }).status).toBe(0);
    expect(existsSync(calls), 'no fix commands run on SubagentStop').toBe(
      false,
    );
  });

  it('still fixes on Stop, the one pass per fan-out', () => {
    expect(
      runScript(root, SCRIPT, { input: '{"hook_event_name":"Stop"}' }).status,
    ).toBe(0);
    expect(readFileSync(calls, 'utf8')).toMatch(/--filter @fix\/cityville fix/);
  });

  it('runs on SubagentStop when fix.onSubagentStop opts back in', () => {
    setRunner(root, { onSubagentStop: true });
    const sub = '{"hook_event_name":"SubagentStop"}';
    expect(runScript(root, SCRIPT, { input: sub }).status).toBe(0);
    expect(readFileSync(calls, 'utf8')).toMatch(/--filter @fix\/cityville fix/);
  });
});

describe('lint-format-fix.mjs seeded houserules.config.json', () => {
  let root: string;
  let config: { fix: { onSubagentStop: boolean }; verify?: unknown };

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    config = JSON.parse(
      readFileSync(join(root, '.claude/houserules.config.json'), 'utf8'),
    );
  });

  it('carries fix.onSubagentStop: false', () => {
    expect(config.fix.onSubagentStop, 'onSubagentStop off by default').toBe(
      false,
    );
  });

  it('has no verify block by default', () => {
    expect(config.verify).toBe(undefined);
  });
});
