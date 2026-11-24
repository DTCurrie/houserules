import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeCtx } from '#test/ctx-builder';
import { useRepo } from '#test/repo';
import type { Ctx } from '../../../detect.js';
import type { HouseManifest } from '@houserules/api/internal';
import type { Settings } from '@houserules/api';
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
  const manifest: HouseManifest = {
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
    'node .claude/scripts/notice-interim.mjs',
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
    ctx.claude.houseConfig = {
      version: 2,
      targets: [{ name: 'core', packageName: '.', fixCommands: ['lint:fix'] }],
    } as Ctx['claude']['houseConfig'];

    expect(checkSettingsWiring('/repo', ctx).findings).toContainEqual(
      expect.objectContaining({
        msg: expect.stringContaining('lint-format-fix.mjs not wired'),
      }),
    );
  });

  it('errors when houserules is installed but settings.json is absent', () => {
    const ctx = installedCtx({
      modules: ['core'],
      claude: { settingsExists: false },
    });

    expect(checkSettingsWiring('/repo', ctx).findings).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        msg: 'houserules installed but .claude/settings.json is missing (hooks unwired) — rerun init',
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

  it('warns when settings.local.json wires a houserules hook script with a command that differs from the managed one', () => {
    const root = useRepo('pnpm-single');
    writeSettingsLocal(
      root,
      wiring('node /custom/path/guard-bash.mjs --verbose'),
    );
    const ctx = installedCtx({
      modules: ['core'],
      claude: {
        settingsLocalExists: true,
        settings: coreWiring(),
      },
    });

    expect(checkSettingsWiring(root, ctx).findings).toContainEqual(
      expect.objectContaining({
        level: 'WARN',
        msg: 'settings.local.json wires a houserules hook script with a command that differs from the managed one, so it runs beside it and drifts from updates',
      }),
    );
  });

  it('reports nothing when settings.local.json repeats the managed command exactly', () => {
    const root = useRepo('pnpm-single');
    writeSettingsLocal(root, wiring('node .claude/scripts/guard-bash.mjs'));
    const ctx = installedCtx({
      modules: ['core'],
      claude: {
        settingsLocalExists: true,
        settings: coreWiring(),
      },
    });

    expect(checkSettingsWiring(root, ctx).findings).toEqual([]);
  });

  it('ignores a settings.local.json that wires a script houserules does not own', () => {
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

  it('warns when settings.local.json carries a differing read-guard command', () => {
    const root = useRepo('pnpm-single');
    writeSettingsLocal(root, wiring('node ./guard-read.mjs'));
    const ctx = installedCtx({
      modules: ['read-guard'],
      claude: {
        settingsLocalExists: true,
        settings: wiring('node .claude/scripts/guard-read.mjs'),
      },
    });

    expect(checkSettingsWiring(root, ctx).findings).toContainEqual(
      expect.objectContaining({
        msg: 'settings.local.json wires a houserules hook script with a command that differs from the managed one, so it runs beside it and drifts from updates',
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

describe('checkSettingsWiring, given an install whose settings.json runs the hook dispatcher', () => {
  const DISPATCHER = 'node .claude/scripts/hook-dispatch.mjs';

  function dispatchedSettings(...events: string[]): Settings {
    return {
      hooks: Object.fromEntries(
        events.map((event) => [
          event,
          [{ hooks: [{ type: 'command' as const, command: DISPATCHER }] }],
        ]),
      ),
    };
  }

  function writeWiring(root: string, content: unknown): void {
    mkdirSync(join(root, '.claude', 'scripts'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'scripts', 'hook-wiring.json'),
      typeof content === 'string' ? content : JSON.stringify(content),
    );
  }

  const CORE_WIRING = {
    version: 1,
    events: {
      PreToolUse: [{ script: 'guard-bash.mjs', matcher: 'Bash' }],
      UserPromptSubmit: [
        { script: 'ledger-inject.mjs' },
        { script: 'notice-interim.mjs' },
      ],
    },
  };

  it('reports nothing when the wiring file runs every module hook script', () => {
    const root = useRepo('pnpm-single');
    writeWiring(root, CORE_WIRING);
    const ctx = installedCtx({
      modules: ['core'],
      claude: {
        settings: dispatchedSettings('PreToolUse', 'UserPromptSubmit'),
      },
    });

    expect(checkSettingsWiring(root, ctx).findings).toEqual([]);
  });

  it('warns, naming the wiring file, when a module hook script is missing from it', () => {
    const root = useRepo('pnpm-single');
    writeWiring(root, {
      version: 1,
      events: {
        PreToolUse: [{ script: 'guard-bash.mjs', matcher: 'Bash' }],
        UserPromptSubmit: [{ script: 'notice-interim.mjs' }],
      },
    });
    const ctx = installedCtx({
      modules: ['core'],
      claude: {
        settings: dispatchedSettings('PreToolUse', 'UserPromptSubmit'),
      },
    });

    expect(checkSettingsWiring(root, ctx).findings).toEqual([
      {
        level: 'WARN',
        msg: 'module "core": hook script ledger-inject.mjs not wired in .claude/scripts/hook-wiring.json or .claude/settings.json',
      },
    ]);
  });

  it('warns when the wiring file is missing', () => {
    const root = useRepo('pnpm-single');
    const ctx = installedCtx({
      modules: [],
      claude: { settings: dispatchedSettings('PreToolUse') },
    });

    expect(checkSettingsWiring(root, ctx).findings).toEqual([
      {
        level: 'WARN',
        msg: '.claude/scripts/hook-wiring.json is missing, so the hook-dispatch.mjs entries in .claude/settings.json run no hooks — run: npx houserules update',
      },
    ]);
  });

  it('warns when the wiring file is not JSON', () => {
    const root = useRepo('pnpm-single');
    writeWiring(root, '{ broken');
    const ctx = installedCtx({
      modules: [],
      claude: { settings: dispatchedSettings('PreToolUse') },
    });

    expect(checkSettingsWiring(root, ctx).findings).toEqual([
      expect.objectContaining({
        level: 'WARN',
        msg: expect.stringMatching(
          /^\.claude\/scripts\/hook-wiring\.json unparseable \(/,
        ),
      }),
    ]);
  });

  it('warns when the wiring file wires an event settings.json has no dispatcher entry for', () => {
    const root = useRepo('pnpm-single');
    writeWiring(root, CORE_WIRING);
    const ctx = installedCtx({
      modules: [],
      claude: { settings: dispatchedSettings('PreToolUse') },
    });

    expect(checkSettingsWiring(root, ctx).findings).toEqual([
      {
        level: 'WARN',
        msg: '.claude/scripts/hook-wiring.json wires UserPromptSubmit hooks but .claude/settings.json has no hook-dispatch.mjs entry for UserPromptSubmit, so they never run — run: npx houserules update',
      },
    ]);
  });

  it('warns when settings.local.json wires a script the dispatcher already runs', () => {
    const root = useRepo('pnpm-single');
    writeWiring(root, CORE_WIRING);
    writeSettingsLocal(root, wiring('node .claude/scripts/guard-bash.mjs'));
    const ctx = installedCtx({
      modules: ['core'],
      claude: {
        settingsLocalExists: true,
        settings: dispatchedSettings('PreToolUse', 'UserPromptSubmit'),
      },
    });

    expect(checkSettingsWiring(root, ctx).findings).toEqual([
      {
        level: 'WARN',
        msg: 'settings.local.json wires a houserules hook script with a command that differs from the managed one, so it runs beside it and drifts from updates',
      },
    ]);
  });
});

describe('KIT_HOOK_SCRIPT_RE', () => {
  it.each(Array.from(new Set(Object.values(HOOK_SCRIPTS).flat())))(
    'matches %s',
    (scriptName) => {
      expect(
        KIT_HOOK_SCRIPT_RE.test(`node .claude/scripts/${scriptName}`),
        `matches ${scriptName}`,
      ).toBe(true);
    },
  );
});

describe('checkSettingsWiring, given a config and a manifest that disagree on modules', () => {
  it('checks the module the config names, not the manifest one', () => {
    const ctx = installedCtx({ modules: ['lint-fix'] });
    const disagreeing: Ctx = {
      ...ctx,
      claude: {
        ...ctx.claude,
        houseConfig: { version: 2, modules: ['core'] } as never,
      },
    };

    expect(checkSettingsWiring('/repo', disagreeing).findings).toContainEqual(
      expect.objectContaining({
        msg: 'module "core": hook script guard-bash.mjs not wired in .claude/settings.json',
      }),
    );
  });
});
