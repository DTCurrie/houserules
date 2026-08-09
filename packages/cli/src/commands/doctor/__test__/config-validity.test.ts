import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeCtx } from '#test/ctx-builder';
import { useRepo } from '#test/repo';
import type { KitConfig } from '../../../core/config.js';
import type { KitManifest } from '../../../core/manifest.js';
import type { Ctx } from '../../../detect.js';
import { checkConfigValidity } from '../config-validity.js';

const STUDIO_TARGET = {
  name: 'studio',
  prefix: 'STUDIO',
  packageName: '@fix/studio',
  pathPrefix: 'apps/studio',
  sourcePath: 'apps/studio/src',
  label: 'Studio',
};

const CITYVILLE_TARGET = {
  name: 'cityville',
  prefix: 'CITY',
  packageName: '@fix/cityville',
  pathPrefix: 'games/cityville',
  sourcePath: 'games/cityville/src',
  label: 'Cityville',
};

function stageConfig(
  root: string,
  config: Record<string, unknown>,
  modules = ['core'],
): Ctx {
  const withDefaults = { packageManager: 'pnpm', ...config };
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'kit.config.json'),
    JSON.stringify(withDefaults, null, 2),
  );
  const manifest: KitManifest = {
    kitVersion: '1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    modules,
    files: {},
  };
  const base = makeCtx();
  return {
    ...base,
    claude: {
      ...base.claude,
      manifest,
      kitConfig: config as unknown as KitConfig,
    },
  };
}

function messages(root: string, ctx: Ctx): string[] {
  return checkConfigValidity(root, ctx).findings.map((f) => f.msg);
}

describe('checkConfigValidity, when the config is absent', () => {
  it('errors when the kit is installed but the config is gone', () => {
    const base = makeCtx();
    const ctx = {
      ...base,
      claude: {
        ...base.claude,
        manifest: {
          kitVersion: '1.0.0',
          installedAt: '2026-01-01T00:00:00.000Z',
          modules: ['core'],
          files: {},
        },
      },
    };

    expect(checkConfigValidity('/repo', ctx).findings).toEqual([
      { level: 'ERROR', msg: 'no .claude/kit.config.json' },
    ]);
  });

  it('warns rather than errors when the kit was never installed', () => {
    expect(checkConfigValidity('/repo', makeCtx()).findings).toEqual([
      { level: 'WARN', msg: 'no .claude/kit.config.json' },
    ]);
  });
});

describe('checkConfigValidity, schema validation', () => {
  it('reports a schema rejection separately from the findings so it can drive exit 2', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      packageManager: '',
      targets: [STUDIO_TARGET, CITYVILLE_TARGET],
    });

    expect(checkConfigValidity(root, ctx).configProblems).toEqual([
      expect.stringContaining('packageManager'),
    ]);
  });

  it('also raises each schema rejection as an ERROR finding', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      packageManager: '',
      targets: [STUDIO_TARGET, CITYVILLE_TARGET],
    });

    expect(checkConfigValidity(root, ctx).findings[0]).toMatchObject({
      level: 'ERROR',
      msg: expect.stringContaining('kit.config.json:'),
    });
  });

  it('rejects a config declaring an older schema version', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 1,
      targets: [STUDIO_TARGET, CITYVILLE_TARGET],
    });

    expect(checkConfigValidity(root, ctx).configProblems).toEqual([
      expect.stringContaining('version'),
    ]);
  });

  it('skips the reality checks once the schema rejects the config', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      packageManager: '',
      targets: [{ ...STUDIO_TARGET, pathPrefix: 'apps/ghost' }],
    });

    expect(messages(root, ctx)).toEqual([
      expect.stringContaining('kit.config.json: packageManager'),
    ]);
  });

  it('does not walk targets that are not an array, which used to throw', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, { version: 2, targets: 'nope' });

    expect(checkConfigValidity(root, ctx).configProblems).toEqual([
      expect.stringContaining('targets'),
    ]);
  });
});

describe('checkConfigValidity, target reality', () => {
  it('warns when a target pathPrefix names a directory that does not exist', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      targets: [
        { ...STUDIO_TARGET, pathPrefix: 'apps/ghost' },
        CITYVILLE_TARGET,
      ],
    });

    expect(messages(root, ctx)).toContain(
      'target "studio": pathPrefix apps/ghost does not exist',
    );
  });

  it('warns when a target sourcePath names a directory that does not exist', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      targets: [
        { ...STUDIO_TARGET, sourcePath: 'apps/studio/ghost' },
        CITYVILLE_TARGET,
      ],
    });

    expect(messages(root, ctx)).toContain(
      'target "studio": sourcePath apps/studio/ghost does not exist',
    );
  });

  it('warns when a target names a package the workspace does not contain', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      targets: [
        { ...STUDIO_TARGET, packageName: '@fix/ghost' },
        CITYVILLE_TARGET,
      ],
    });

    expect(messages(root, ctx)).toContain(
      'target "studio": package @fix/ghost not found in the workspace',
    );
  });

  it('warns when a declared fix command is not a script in the target package.json', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      targets: [
        { ...STUDIO_TARGET, fixCommands: ['nope:fix'] },
        CITYVILLE_TARGET,
      ],
    });

    expect(messages(root, ctx)).toContain(
      'target "studio": fix script "nope:fix" not in apps/studiopackage.json',
    );
  });

  it('accepts a fix command the target package.json actually declares', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      targets: [
        { ...STUDIO_TARGET, fixCommands: ['lint:fix'] },
        CITYVILLE_TARGET,
      ],
    });

    expect(messages(root, ctx)).toEqual([]);
  });

  it('falls back to the global fix commands when a target declares none', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      fix: {
        runner: 'pnpm',
        filterFlag: '--filter',
        runScriptPrefix: ['run'],
        commands: ['nope:fix'],
      },
      targets: [STUDIO_TARGET, CITYVILLE_TARGET],
    });

    expect(messages(root, ctx)).toContain(
      'target "studio": fix script "nope:fix" not in apps/studiopackage.json',
    );
  });

  it('treats an explicit null fixCommands as no commands rather than inheriting the global ones', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      fix: {
        runner: 'pnpm',
        filterFlag: '--filter',
        runScriptPrefix: ['run'],
        commands: ['nope:fix'],
      },
      targets: [
        { ...STUDIO_TARGET, fixCommands: null },
        { ...CITYVILLE_TARGET, fixCommands: null },
      ],
    });

    expect(messages(root, ctx)).toEqual([]);
  });
});

describe('checkConfigValidity, when fix.filterFlag is empty', () => {
  const ROOT_FIX = {
    runner: 'pnpm',
    filterFlag: '',
    runScriptPrefix: ['run'],
    commands: ['fix'],
  };

  it('checks each fix command once against the root package.json instead of once per target', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      fix: { ...ROOT_FIX, commands: ['nope:fix'] },
      targets: [STUDIO_TARGET, CITYVILLE_TARGET],
    });

    expect(messages(root, ctx)).toEqual([
      'fix script "nope:fix" not in the root package.json — fix.filterFlag is empty, so every fix command runs as a root script',
    ]);
  });

  it('accepts a fix command the root package.json declares, even though no target package does', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      fix: ROOT_FIX,
      targets: [STUDIO_TARGET, CITYVILLE_TARGET],
    });

    expect(messages(root, ctx)).toEqual([]);
  });

  it('reports one finding per distinct missing command, not per command per target', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      fix: { ...ROOT_FIX, commands: ['nope:fix', 'also-nope'] },
      targets: [STUDIO_TARGET, CITYVILLE_TARGET],
    });

    expect(messages(root, ctx)).toHaveLength(2);
  });
});

describe('checkConfigValidity, verify commands', () => {
  it('ignores a missing verify script while verify-changed is not installed', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      targets: [
        { ...STUDIO_TARGET, verifyCommands: ['nope:verify'] },
        CITYVILLE_TARGET,
      ],
    });

    expect(messages(root, ctx)).toEqual([]);
  });

  it('warns about a missing verify script once verify-changed is installed', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(
      root,
      {
        version: 2,
        targets: [
          { ...STUDIO_TARGET, verifyCommands: ['nope:verify'] },
          CITYVILLE_TARGET,
        ],
      },
      ['core', 'verify-changed'],
    );

    expect(messages(root, ctx)).toContain(
      'target "studio": verify script "nope:verify" not in apps/studiopackage.json',
    );
  });

  it('warns when verify-changed is installed and no verify command is named anywhere', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(
      root,
      { version: 2, targets: [STUDIO_TARGET, CITYVILLE_TARGET] },
      ['core', 'verify-changed'],
    );

    expect(messages(root, ctx)).toEqual([
      'verify-changed is installed but no verify command is configured — add a "verify" block to .claude/kit.config.json, or "verifyCommands" to each target. Without one the helper falls back to a "verify" script and fails when you run it.',
    ]);
  });

  it('stays quiet when a global verify block names the commands', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(
      root,
      {
        version: 2,
        verify: {
          runner: 'pnpm',
          filterFlag: '--filter',
          runScriptPrefix: ['run'],
          commands: ['verify'],
        },
        targets: [STUDIO_TARGET, CITYVILLE_TARGET],
      },
      ['core', 'verify-changed'],
    );

    expect(messages(root, ctx)).toEqual([]);
  });

  it('checks a verify command against the root package.json when verify.filterFlag is empty', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(
      root,
      {
        version: 2,
        verify: {
          runner: 'pnpm',
          filterFlag: '',
          runScriptPrefix: ['run'],
          commands: ['verify'],
        },
        targets: [
          { ...STUDIO_TARGET, verifyCommands: ['nope:verify'] },
          CITYVILLE_TARGET,
        ],
      },
      ['core', 'verify-changed'],
    );

    expect(messages(root, ctx)).toEqual([
      'verify script "nope:verify" not in the root package.json — verify.filterFlag is empty, so every verify command runs as a root script',
    ]);
  });
});

describe('checkConfigValidity, plugin resolution', () => {
  it('reports an unresolvable plugin as both a config problem and an ERROR finding', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      targets: [STUDIO_TARGET, CITYVILLE_TARGET],
      plugins: [{ name: '@acme/does-not-exist', alias: 'acme' }],
    });

    const result = checkConfigValidity(root, ctx);

    expect(result.configProblems).toEqual([
      expect.stringContaining('@acme/does-not-exist'),
    ]);
    expect(result.findings).toEqual([
      {
        level: 'ERROR',
        msg: expect.stringContaining('@acme/does-not-exist'),
      },
    ]);
  });

  it('skips the reality checks once a plugin fails to resolve, the same as a schema rejection', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      targets: [{ ...STUDIO_TARGET, pathPrefix: 'apps/ghost' }],
      plugins: [{ name: '@acme/does-not-exist', alias: 'acme' }],
    });

    expect(messages(root, ctx)).toEqual([
      expect.stringContaining('@acme/does-not-exist'),
    ]);
  });
});

describe('checkConfigValidity, workspace coverage', () => {
  it('warns about a workspace package no target covers', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, { version: 2, targets: [STUDIO_TARGET] });

    expect(messages(root, ctx)).toContain(
      'workspace package "@fix/cityville" (games/cityville) has no kit target — add one to .claude/kit.config.json targets[] by hand (re-running init skips the existing config)',
    );
  });

  it('reports nothing when every workspace package has a target', () => {
    const root = useRepo('pnpm-monorepo');
    const ctx = stageConfig(root, {
      version: 2,
      targets: [STUDIO_TARGET, CITYVILLE_TARGET],
    });

    expect(messages(root, ctx)).toEqual([]);
  });

  it('does not warn about a workspace package a repo-relative plugins[] entry resolves to', () => {
    const root = useRepo('pnpm-monorepo');
    writeFileSync(
      join(root, 'games/cityville', 'package.json'),
      JSON.stringify(
        { name: '@fix/cityville', private: true, main: 'index.cjs' },
        null,
        2,
      ),
    );
    writeFileSync(
      join(root, 'games/cityville', 'index.cjs'),
      'module.exports = () => [];\n',
    );
    const ctx = stageConfig(root, {
      version: 2,
      targets: [STUDIO_TARGET],
      plugins: [{ name: './games/cityville', alias: 'cityville' }],
    });

    expect(messages(root, ctx)).toEqual([]);
  });
});
