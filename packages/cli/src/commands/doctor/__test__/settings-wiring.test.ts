import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeCtx } from '#test/ctx-builder';
import { useRepo } from '#test/repo';
import type { Ctx } from '../../../detect.js';
import type { KitManifest } from '@agent-kit/api/internal';
import type { Settings } from '@agent-kit/api';
import {
  allHookCommands,
  checkSettingsWiring,
  HOOK_SCRIPTS,
  KIT_HOOK_SCRIPT_RE,
} from '../settings-wiring.js';

function installedCtx(overrides: {
  modules: string[];
  claude?: Partial<Ctx['claude']>;
}): Ctx {
  const manifest: KitManifest = {
    kitVersion: '1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    modules: overrides.modules,
    files: {},
  };
  return makeCtx({
    claude: {
      ...makeCtx().claude,
      manifest,
      settingsExists: true,
      settings: {},
      ...overrides.claude,
    },
  });
}

function wiring(...commands: string[]): Settings {
  return {
    hooks: {
      PreToolUse: [
        { hooks: commands.map((command) => ({ type: 'command', command })) },
      ],
    },
  };
}

function coreWiring(): Settings {
  return wiring(
    'node .claude/scripts/guard-bash.mjs',
    'node .claude/scripts/ledger-inject.mjs',
  );
}

function writeSettingsLocal(root: string, content: unknown): void {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'settings.local.json'),
    JSON.stringify(content),
  );
}

describe('allHookCommands', () => {
  it('returns an empty list for null settings', () => {
    expect(allHookCommands(null)).toEqual([]);
  });

  it('returns an empty list for undefined settings', () => {
    expect(allHookCommands(undefined)).toEqual([]);
  });

  it('returns an empty list when settings has no hooks', () => {
    expect(allHookCommands({})).toEqual([]);
  });

  it('flattens a single hook command', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command' as const, command: 'a.mjs' }] },
        ],
      },
    };
    expect(allHookCommands(settings)).toEqual(['a.mjs']);
  });

  it('flattens several hook commands across several events', () => {
    const settings = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command' as const, command: 'a.mjs' }] },
        ],
        PostToolUse: [
          {
            hooks: [
              { type: 'command' as const, command: 'b.mjs' },
              { type: 'command' as const, command: 'c.mjs' },
            ],
          },
        ],
      },
    };
    expect(allHookCommands(settings)).toEqual(['a.mjs', 'b.mjs', 'c.mjs']);
  });
});

describe('checkSettingsWiring', () => {
  it('warns when an installed module has no hook command naming its script', () => {
    const ctx = installedCtx({ modules: ['core'] });

    expect(checkSettingsWiring('/repo', ctx).findings).toContainEqual(
      expect.objectContaining({
        level: 'WARN',
        msg: 'module "core": hook script guard-bash.mjs not wired in .claude/settings.json',
      }),
    );
  });

  it('reports nothing when the module hook script is wired', () => {
    const ctx = installedCtx({
      modules: ['core'],
      claude: { settings: coreWiring() },
    });

    expect(checkSettingsWiring('/repo', ctx).findings).toEqual([]);
  });

  it('skips the lint-fix wiring check when no target declares a fix command', () => {
    const ctx = installedCtx({ modules: ['lint-fix'] });

    expect(checkSettingsWiring('/repo', ctx).findings).toEqual([]);
  });

  it('warns about unwired lint-fix once a target declares a fix command', () => {
    const ctx = installedCtx({ modules: ['lint-fix'] });
    ctx.claude.kitConfig = {
      version: 2,
      targets: [{ name: 'core', packageName: '.', fixCommands: ['lint:fix'] }],
    } as Ctx['claude']['kitConfig'];

    expect(checkSettingsWiring('/repo', ctx).findings).toContainEqual(
      expect.objectContaining({
        msg: expect.stringContaining('lint-format-fix.mjs not wired'),
      }),
    );
  });

  it('errors when the kit is installed but settings.json is absent', () => {
    const ctx = installedCtx({
      modules: ['core'],
      claude: { settingsExists: false },
    });

    expect(checkSettingsWiring('/repo', ctx).findings).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        msg: 'kit installed but .claude/settings.json is missing (hooks unwired) — rerun init',
      }),
    );
  });

  it('errors when settings.json did not parse', () => {
    const ctx = installedCtx({
      modules: ['core'],
      claude: { settingsParseError: 'Unexpected token }' },
    });

    expect(checkSettingsWiring('/repo', ctx).findings).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        msg: '.claude/settings.json unparseable: Unexpected token }',
      }),
    );
  });

  it('warns when settings.local.json wires a kit hook script that would then run twice', () => {
    const root = useRepo('pnpm-single');
    writeSettingsLocal(root, wiring('node .claude/scripts/guard-bash.mjs'));
    const ctx = installedCtx({
      modules: ['core'],
      claude: {
        settingsLocalExists: true,
        settings: coreWiring(),
      },
    });

    expect(checkSettingsWiring(root, ctx).findings).toContainEqual(
      expect.objectContaining({
        msg: 'settings.local.json also wires kit hook scripts — they will run twice',
      }),
    );
  });

  it('ignores a settings.local.json that wires a script the kit does not own', () => {
    const root = useRepo('pnpm-single');
    writeSettingsLocal(root, wiring('node ./my-own-hook.mjs'));
    const ctx = installedCtx({
      modules: ['core'],
      claude: {
        settingsLocalExists: true,
        settings: coreWiring(),
      },
    });

    expect(checkSettingsWiring(root, ctx).findings).toEqual([]);
  });

  it('warns when settings.local.json duplicates the read-guard hook script', () => {
    const root = useRepo('pnpm-single');
    writeSettingsLocal(root, wiring('node .claude/scripts/guard-read.mjs'));
    const ctx = installedCtx({
      modules: ['read-guard'],
      claude: {
        settingsLocalExists: true,
        settings: wiring('node .claude/scripts/guard-read.mjs'),
      },
    });

    expect(checkSettingsWiring(root, ctx).findings).toContainEqual(
      expect.objectContaining({
        msg: 'settings.local.json also wires kit hook scripts — they will run twice',
      }),
    );
  });

  it('tolerates an unparseable settings.local.json, since that file is the user’s business', () => {
    const root = useRepo('pnpm-single');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.local.json'), '{ broken');
    const ctx = installedCtx({
      modules: ['core'],
      claude: {
        settingsLocalExists: true,
        settings: coreWiring(),
      },
    });

    expect(checkSettingsWiring(root, ctx).findings).toEqual([]);
  });
});

describe('KIT_HOOK_SCRIPT_RE', () => {
  it.each(Array.from(new Set(Object.values(HOOK_SCRIPTS).flat())))(
    'matches %s',
    (scriptName) => {
      expect(
        KIT_HOOK_SCRIPT_RE.test(`node .claude/scripts/${scriptName}`),
      ).toBe(true);
    },
  );
});
