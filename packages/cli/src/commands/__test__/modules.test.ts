import { beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { treeHash, useInstalledRepo, useRepo } from '#test/repo';
import { runCli, type RunResult } from '#test/run';
import {
  allHookCommands,
  editKitConfig,
  kitConfigPath,
  manifestOf,
  readJson,
  settingsOf,
} from '#test/installed-tree';
import { optionBearingAdditions, parseRequested } from '../modules.js';
import { MODULES } from '../../plan.js';
import type { ModuleDef } from '../../module-def.js';
import type { Registry, RegisteredModule } from '../../plugin-registry.js';

function installedWithReadGuard(): string {
  const root = useInstalledRepo('npm-single', { modules: 'read-guard' });
  expect(existsSync(join(root, '.claude/scripts/guard-read.mjs'))).toBe(true);
  expect(allHookCommands(root).some((c) => c.includes('guard-read.mjs'))).toBe(
    true,
  );
  return root;
}

const moduleDef = (id: string): ModuleDef => ({
  id,
  title: id,
  group: 'optional',
  hint: () => '',
  defaultEnabled: () => false,
  plan: () => [],
});

const registeredModule = (
  id: string,
  source: RegisteredModule['source'] = null,
): RegisteredModule => ({ id, def: moduleDef(id), source });

const lockedModule = (id: string): RegisteredModule => ({
  id,
  def: { ...moduleDef(id), locked: true },
  source: null,
});

function registryOf(modules: RegisteredModule[]): Registry {
  return {
    modules,
    plugins: [],
    get: (id) => modules.find((m) => m.id === id),
  };
}

describe('parseRequested', () => {
  const registry = registryOf([
    lockedModule('core'),
    registeredModule('output-prose'),
    registeredModule('changesets'),
    registeredModule('read-guard'),
  ]);
  const installed = new Set(['core', 'read-guard']);

  it.each([
    {
      name: 'undefined flag',
      flag: undefined,
      chosen: [],
      redundant: [],
      unresolvable: [],
    },
    {
      name: 'empty string',
      flag: '',
      chosen: [],
      redundant: [],
      unresolvable: [],
    },
    {
      name: 'a single addable id',
      flag: 'output-prose',
      chosen: ['output-prose'],
      redundant: [],
      unresolvable: [],
    },
    {
      name: 'several comma-separated addable ids',
      flag: 'output-prose,changesets',
      chosen: ['output-prose', 'changesets'],
      redundant: [],
      unresolvable: [],
    },
    {
      name: 'a single unresolvable id',
      flag: 'nope',
      chosen: [],
      redundant: [],
      unresolvable: ['nope'],
    },
    {
      name: 'an already-installed id',
      flag: 'read-guard',
      chosen: [],
      redundant: ['read-guard'],
      unresolvable: [],
    },
    {
      name: 'a locked id, which is installed by definition',
      flag: 'core',
      chosen: [],
      redundant: ['core'],
      unresolvable: [],
    },
    {
      name: 'one id of each kind at once',
      flag: 'output-prose,read-guard,nope',
      chosen: ['output-prose'],
      redundant: ['read-guard'],
      unresolvable: ['nope'],
    },
    {
      name: 'whitespace around entries',
      flag: ' output-prose , changesets ',
      chosen: ['output-prose', 'changesets'],
      redundant: [],
      unresolvable: [],
    },
    {
      name: 'a trailing comma',
      flag: 'output-prose,',
      chosen: ['output-prose'],
      redundant: [],
      unresolvable: [],
    },
    {
      name: 'a doubled comma',
      flag: 'output-prose,,changesets',
      chosen: ['output-prose', 'changesets'],
      redundant: [],
      unresolvable: [],
    },
    {
      name: 'a repeated addable id',
      flag: 'output-prose,output-prose',
      chosen: ['output-prose'],
      redundant: [],
      unresolvable: [],
    },
    {
      name: 'a repeated unresolvable id',
      flag: 'nope,nope',
      chosen: [],
      redundant: [],
      unresolvable: ['nope'],
    },
  ])('$name', ({ flag, chosen, redundant, unresolvable }) => {
    expect(parseRequested(flag, registry, installed)).toEqual({
      chosen,
      redundant,
      unresolvable,
    });
  });
});

describe('modules command on an initialized pnpm monorepo', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('does not install an off-by-default module before it is requested', () => {
    const manifest = manifestOf(root);
    expect(manifest.modules.includes('read-guard')).toBeFalsy();
    expect(
      existsSync(join(root, '.claude/scripts/guard-read.mjs')),
    ).toBeFalsy();
  });

  it('installs the module and records it in the manifest when requested', () => {
    const r = runCli(['modules', '--yes', '--modules=read-guard', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(
      existsSync(join(root, '.claude/scripts/guard-read.mjs')),
    ).toBeTruthy();
    const manifest = manifestOf(root);
    expect(manifest.modules.includes('read-guard')).toBeTruthy();
  });

  it('leaves doctor green after enabling a module', () => {
    expect(
      runCli(['modules', '--yes', '--modules=read-guard', root]).status,
    ).toBe(0);
    expect(runCli(['doctor', root]).status).toBe(0);
  });

  it('is a no-op on a second run requesting the same already-installed module', () => {
    expect(
      runCli(['modules', '--yes', '--modules=read-guard', root]).status,
    ).toBe(0);
    const before = treeHash(root);
    const again = runCli(['modules', '--yes', '--modules=read-guard', root]);
    expect(again.status).toBe(0);
    expect(treeHash(root), 'second run writes nothing').toBe(before);
  });

  it('previews the file it would add without writing, in --dry-run', () => {
    const before = treeHash(root);
    const r = runCli([
      'modules',
      '--yes',
      '--dry-run',
      '--modules=read-guard',
      root,
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/guard-read\.mjs/);
    expect(treeHash(root), 'dry run writes nothing').toBe(before);
  });

  it('reports available modules without writing when given no selection', () => {
    const before = treeHash(root);
    const r = runCli(['modules', '--yes', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout, 'lists read-guard as available').toMatch(/read-guard/);
    expect(treeHash(root), 'listing writes nothing').toBe(before);
  });
});

describe('modules given an id the registry cannot resolve', () => {
  it('exits 1 naming the id even when every module is already installed', () => {
    const root = useInstalledRepo('npm-single', {
      modules: MODULES.map((m) => m.id).join(','),
    });

    const r = runCli(['modules', '--yes', '--modules=bogus/nope', root]);

    expect(r.status, r.stdout).toBe(1);
    expect(r.stderr).toMatch(/bogus\/nope/);
  });

  it('points at the kit.config.json plugins array, since an unregistered plugin looks identical', () => {
    const root = useInstalledRepo('npm-single');

    const r = runCli(['modules', '--yes', '--modules=bogus/nope', root]);

    expect(r.stderr).toMatch(/plugins/);
  });

  it('exits 1 without --yes too, rather than silently ignoring the flag', () => {
    const root = useInstalledRepo('npm-single');

    const r = runCli(['modules', '--modules=bogus/nope', root]);

    expect(r.status, r.stdout).toBe(1);
  });

  it('writes nothing', () => {
    const root = useInstalledRepo('npm-single');
    const before = treeHash(root);

    runCli(['modules', '--yes', '--modules=read-guard,bogus/nope', root]);

    expect(treeHash(root)).toBe(before);
  });
});

describe('modules given an id that is already installed', () => {
  it('reports it as installed rather than asking for a --modules flag the user just passed', () => {
    const root = useInstalledRepo('npm-single', { modules: 'read-guard' });

    const r = runCli(['modules', '--yes', '--modules=read-guard', root]);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Already installed: read-guard/);
  });

  it('reports a locked module as installed rather than unresolvable', () => {
    const root = useInstalledRepo('npm-single');

    const r = runCli(['modules', '--yes', '--modules=core', root]);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Already installed: core/);
  });
});

describe('modules command on an uninitialized repo', () => {
  it('refuses to run and points at `npx agent-kit init`', () => {
    const root = useRepo('non-js');
    const r = runCli(['modules', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/npx agent-kit init/);
  });
});

describe('modules --disable', () => {
  let root: string;

  beforeEach(() => {
    root = installedWithReadGuard();
  });

  it('removes the disabled module’s script and unwires its hook', () => {
    const r = runCli(['modules', root, '--yes', '--disable', 'read-guard']);
    expect(r.status, r.stderr).toBe(0);

    expect(existsSync(join(root, '.claude/scripts/guard-read.mjs'))).toBe(
      false,
    );
    expect(
      allHookCommands(root).some((c) => c.includes('guard-read.mjs')),
    ).toBe(false);
  });

  it('drops the module from the manifest', () => {
    runCli(['modules', root, '--yes', '--disable', 'read-guard']);
    expect(manifestOf(root).modules).not.toContain('read-guard');
  });

  describe('other things a disable must not touch', () => {
    beforeEach(() => {
      const path = join(root, '.claude/settings.json');
      const settings = settingsOf(root);
      settings.hooks ??= {};
      settings.hooks.Stop ??= [];
      settings.hooks.Stop.push({
        hooks: [{ command: 'node ./my-own-stop-hook.js' }],
      });
      settings.permissions ??= {};
      settings.permissions.allow = [
        ...(settings.permissions.allow ?? []),
        'Bash(echo mine)',
      ];
      writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);

      expect(
        runCli(['modules', root, '--yes', '--disable', 'read-guard']).status,
      ).toBe(0);
    });

    it('keeps a hook the user added themselves', () => {
      expect(allHookCommands(root)).toContain('node ./my-own-stop-hook.js');
    });

    it('keeps another kit module’s hook wired', () => {
      expect(
        allHookCommands(root).some((c) => c.includes('guard-bash.mjs')),
      ).toBe(true);
    });

    it('keeps a permission entry the user added themselves', () => {
      expect(settingsOf(root).permissions?.allow).toContain('Bash(echo mine)');
    });
  });

  it('returns to the same settings document after enable, disable, then re-enable', () => {
    const enabled = readFileSync(join(root, '.claude/settings.json'), 'utf8');

    expect(
      runCli(['modules', root, '--yes', '--disable', 'read-guard']).status,
    ).toBe(0);
    expect(
      runCli(['modules', root, '--yes', '--modules', 'read-guard']).status,
    ).toBe(0);

    expect(existsSync(join(root, '.claude/scripts/guard-read.mjs'))).toBe(true);
    expect(
      allHookCommands(root).some((c) => c.includes('guard-read.mjs')),
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')),
    ).toEqual(JSON.parse(enabled));
  });

  it('refuses to disable core', () => {
    const r = runCli(['modules', root, '--yes', '--disable', 'core']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Cannot disable core/);
  });

  it('leaves core’s files in place when disabling core is refused', () => {
    runCli(['modules', root, '--yes', '--disable', 'core']);
    expect(existsSync(join(root, '.claude/scripts/guard-bash.mjs'))).toBe(true);
  });

  it('refuses an unknown module id rather than silently ignoring it', () => {
    const r = runCli(['modules', root, '--yes', '--disable', 'nope']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown module/);
  });

  describe('a locally edited file', () => {
    let script: string;

    beforeEach(() => {
      script = join(root, '.claude/scripts/guard-read.mjs');
      writeFileSync(script, `${readFileSync(script, 'utf8')}\n// my edit\n`);
    });

    it('is kept on disable, since edits are never deleted without --force', () => {
      expect(
        runCli(['modules', root, '--yes', '--disable', 'read-guard']).status,
      ).toBe(0);
      expect(existsSync(script)).toBe(true);
      expect(readFileSync(script, 'utf8')).toMatch(/my edit/);
    });

    it('is removed once `update --force` sweeps the now-retired file, since the sweep is update’s job, not disable’s', () => {
      expect(
        runCli(['modules', root, '--yes', '--disable', 'read-guard']).status,
      ).toBe(0);
      expect(runCli(['update', root, '--force']).status).toBe(0);
      expect(existsSync(script)).toBe(false);
    });

    it('is removed immediately when --force is passed to the disable itself', () => {
      expect(
        runCli(['modules', root, '--yes', '--force', '--disable', 'read-guard'])
          .status,
      ).toBe(0);
      expect(existsSync(script)).toBe(false);
    });
  });

  it('writes nothing to disk in --dry-run mode', () => {
    const before = readFileSync(join(root, '.claude/settings.json'), 'utf8');
    expect(
      runCli(['modules', root, '--yes', '--dry-run', '--disable', 'read-guard'])
        .status,
    ).toBe(0);
    expect(existsSync(join(root, '.claude/scripts/guard-read.mjs'))).toBe(true);
    expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).toBe(
      before,
    );
  });
});

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_PLUGIN = join(KIT_ROOT, 'test/plugin-fixture');
const OPTION_MODULE = 'fixture/fixture-langs';

function ensureFixtureSelfLink(): void {
  const link = join(FIXTURE_PLUGIN, 'node_modules', '@agent-kit', 'cli');
  if (existsSync(link)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(KIT_ROOT, link, 'dir');
}

describe('modules --yes --module-option, adding a module that declares options', () => {
  let root: string;

  beforeEach(() => {
    ensureFixtureSelfLink();
    root = useRepo('npm-single');
    runCli(['init', '--yes', root]);
    editKitConfig(root, (config) => {
      (config as Record<string, unknown>).plugins = [
        { name: FIXTURE_PLUGIN, alias: 'fixture' },
      ];
    });
  });

  function addWithOptions(values: string): RunResult {
    return runCli([
      'modules',
      '--yes',
      `--modules=${OPTION_MODULE}`,
      '--module-option',
      `${OPTION_MODULE}=${values}`,
      root,
    ]);
  }

  it('honors the flag rather than silently installing the module defaults', () => {
    addWithOptions('alpha,beta');

    expect(existsSync(join(root, '.claude/fixture-lang-beta.md'))).toBe(true);
  });

  it('persists the selection so a later update re-resolves to it', () => {
    addWithOptions('alpha,beta');

    expect(readJson(kitConfigPath(root)).moduleOptions).toEqual({
      [OPTION_MODULE]: ['alpha', 'beta'],
    });
  });

  it('installs only the selected values, not every declared choice', () => {
    addWithOptions('beta');

    expect(existsSync(join(root, '.claude/fixture-lang-alpha.md'))).toBe(false);
  });

  it('exits 1 naming the expected form when the flag has no "="', () => {
    const result = runCli([
      'modules',
      '--yes',
      `--modules=${OPTION_MODULE}`,
      '--module-option',
      'no-equals-sign',
      root,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Expected the form id=value1,value2/);
  });

  it('leaves the option-derived file in place across a later update', () => {
    addWithOptions('alpha,beta');

    expect(runCli(['update', root]).status).toBe(0);

    expect(existsSync(join(root, '.claude/fixture-lang-beta.md'))).toBe(true);
  });
});

describe('optionBearingAdditions', () => {
  function withOptions(id: string): RegisteredModule {
    return {
      id,
      def: {
        ...moduleDef(id),
        options: {
          prompt: 'Which?',
          choices: [{ value: 'alpha', label: 'Alpha' }],
          defaults: ['alpha'],
        },
      },
      source: null,
    };
  }

  it('returns a chosen module that declares options', () => {
    const registry = registryOf([withOptions('langs')]);

    expect(
      optionBearingAdditions(registry, ['langs']).map((m) => m.id),
    ).toEqual(['langs']);
  });

  it('skips a chosen module that declares no options', () => {
    const registry = registryOf([registeredModule('plain')]);

    expect(optionBearingAdditions(registry, ['plain'])).toEqual([]);
  });

  it('skips an option-bearing module that this run is not adding', () => {
    const registry = registryOf([withOptions('langs'), withOptions('other')]);

    expect(
      optionBearingAdditions(registry, ['langs']).map((m) => m.id),
    ).toEqual(['langs']);
  });

  it('returns nothing when the run adds nothing', () => {
    const registry = registryOf([withOptions('langs')]);

    expect(optionBearingAdditions(registry, [])).toEqual([]);
  });
});

describe('modules --reconfigure on an installed module that declares options', () => {
  let root: string;

  beforeEach(() => {
    ensureFixtureSelfLink();
    root = useRepo('npm-single');
    runCli(['init', '--yes', root]);
    editKitConfig(root, (config) => {
      (config as Record<string, unknown>).plugins = [
        { name: FIXTURE_PLUGIN, alias: 'fixture' },
      ];
    });
    runCli([
      'modules',
      '--yes',
      `--modules=${OPTION_MODULE}`,
      '--module-option',
      `${OPTION_MODULE}=alpha`,
      root,
    ]);
  });

  function reconfigureTo(values: string, ...extra: string[]): RunResult {
    return runCli([
      'modules',
      '--yes',
      `--reconfigure=${OPTION_MODULE}`,
      '--module-option',
      `${OPTION_MODULE}=${values}`,
      ...extra,
      root,
    ]);
  }

  it('installs the file the newly selected value produces', () => {
    reconfigureTo('beta');

    expect(existsSync(join(root, '.claude/fixture-lang-beta.md'))).toBe(true);
  });

  it('retires the file whose value is no longer selected', () => {
    reconfigureTo('beta');

    expect(existsSync(join(root, '.claude/fixture-lang-alpha.md'))).toBe(false);
  });

  it('records the new selection so update re-resolves to it', () => {
    reconfigureTo('beta');

    expect(readJson(kitConfigPath(root)).moduleOptions).toEqual({
      [OPTION_MODULE]: ['beta'],
    });
  });

  it('leaves the module set untouched', () => {
    reconfigureTo('beta');

    expect(manifestOf(root).modules).toContain(OPTION_MODULE);
  });

  it('keeps a locally edited file instead of pruning it', () => {
    writeFileSync(
      join(root, '.claude/fixture-lang-alpha.md'),
      'my own edits\n',
    );

    reconfigureTo('beta');

    expect(existsSync(join(root, '.claude/fixture-lang-alpha.md'))).toBe(true);
  });

  it('writes nothing in --dry-run', () => {
    const before = treeHash(root);

    expect(reconfigureTo('beta', '--dry-run').status).toBe(0);

    expect(treeHash(root)).toBe(before);
  });

  it('exits 1 when --yes is given without a --module-option for the module', () => {
    const result = runCli([
      'modules',
      '--yes',
      `--reconfigure=${OPTION_MODULE}`,
      root,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--yes cannot prompt/);
  });

  it('exits 1 for a module id the registry does not know', () => {
    const result = runCli([
      'modules',
      '--yes',
      '--reconfigure=nope',
      '--module-option',
      'nope=x',
      root,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Unknown module/);
  });

  it('exits 1 for a known module that is not installed', () => {
    const result = runCli([
      'modules',
      '--yes',
      '--reconfigure=read-guard',
      '--module-option',
      'read-guard=x',
      root,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Not installed/);
  });

  it('exits 1 for an installed module that declares no options', () => {
    const result = runCli([
      'modules',
      '--yes',
      '--reconfigure=core',
      '--module-option',
      'core=x',
      root,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/No options to configure/);
  });
});
