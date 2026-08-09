import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';

import type { CopyAction } from '../actions.js';
import type { KitConfig } from '../core/config.js';
import type { Answers, ModuleDef } from '../module-def.js';
import { payloadPath } from '../paths.js';
import { PluginResolutionError } from '../plugin-registry.js';
import { buildRegistry } from '../plugin-resolver.js';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_ROOT = join(KIT_ROOT, 'test/plugin-fixture');
const LIBS_FIXTURE = join(FIXTURE_ROOT, 'libs');
const BAD_LIB_FIXTURE = join(FIXTURE_ROOT, 'bad-lib');

function ensureFixtureSelfLink(): void {
  const link = join(FIXTURE_ROOT, 'node_modules', '@agent-kit', 'cli');
  if (existsSync(link)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(KIT_ROOT, link, 'dir');
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-resolver-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), '{"name":"target-repo"}\n');
  return root;
}

function buildConfig(plugins: KitConfig['plugins']): KitConfig {
  return {
    version: 2,
    packageManager: 'pnpm',
    targets: [],
    plugins,
  };
}

function stubModule(id: string): ModuleDef {
  return {
    id,
    title: id,
    group: 'optional',
    hint: () => id,
    defaultEnabled: () => true,
    plan: (): [] => [],
  };
}

function runPlan(def: ModuleDef): ReturnType<ModuleDef['plan']> {
  const answers: Answers = {
    moduleIds: [],
    targets: [],
    seedChangesetConfig: false,
    moduleOptions: {},
  };
  return def.plan({ cwd: process.cwd() } as never, answers);
}

describe('buildRegistry', () => {
  it('returns only the built-ins when config is null', () => {
    const builtIns = [stubModule('core')];

    const registry = buildRegistry(makeRoot(), null, builtIns);

    expect(registry.modules.map((m) => m.id)).toEqual(['core']);
    expect(registry.plugins).toEqual([]);
  });

  it('returns only the built-ins when config declares no plugins', () => {
    const builtIns = [stubModule('core')];
    const config = buildConfig(undefined);

    const registry = buildRegistry(makeRoot(), config, builtIns);

    expect(registry.modules.map((m) => m.id)).toEqual(['core']);
  });

  it('loads a local-path plugin and namespaces its module ids under its alias', () => {
    ensureFixtureSelfLink();
    const config = buildConfig([
      { name: FIXTURE_ROOT, alias: 'fixture', config: {} },
    ]);

    const registry = buildRegistry(makeRoot(), config, []);

    expect(registry.modules.map((m) => m.id).sort()).toEqual([
      'fixture/fixture-core',
      'fixture/fixture-extra',
      'fixture/fixture-langs',
    ]);
    expect(registry.plugins).toEqual([
      {
        name: FIXTURE_ROOT,
        alias: 'fixture',
        version: '0.0.0',
        dir: FIXTURE_ROOT,
      },
    ]);
  });

  it('records the plugin as the source on every module it contributes', () => {
    ensureFixtureSelfLink();
    const config = buildConfig([
      { name: FIXTURE_ROOT, alias: 'fixture', config: {} },
    ]);

    const registry = buildRegistry(makeRoot(), config, []);

    for (const registered of registry.modules) {
      expect(registered.source?.alias).toBe('fixture');
    }
  });

  it('passes api.config and api.alias through to the plugin factory, observable in a planned action', () => {
    ensureFixtureSelfLink();
    const config = buildConfig([
      {
        name: FIXTURE_ROOT,
        alias: 'my-alias',
        config: { note: 'from resolver test' },
      },
    ]);

    const registry = buildRegistry(makeRoot(), config, []);
    const extra = registry.get('my-alias/fixture-extra');
    const actions = runPlan(extra!.def);
    const seed = actions.find((action) => action.kind === 'seed');
    const advise = actions.find((action) => action.kind === 'advise');

    expect(seed?.content).toContain('from resolver test');
    expect(advise?.text).toContain('my-alias');
  });

  it('throws PluginResolutionError naming the plugin when an npm package cannot be resolved', () => {
    const config = buildConfig([
      { name: 'this-package-does-not-exist-abcxyz', alias: 'missing' },
    ]);

    expect(() => buildRegistry(makeRoot(), config, [])).toThrow(
      PluginResolutionError,
    );
    try {
      buildRegistry(makeRoot(), config, []);
      expect.unreachable();
    } catch (error) {
      expect((error as PluginResolutionError).pluginName).toBe(
        'this-package-does-not-exist-abcxyz',
      );
    }
  });

  it('throws when a local path resolves to a file rather than a directory', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'not-a-dir.txt'), 'hello');
    const config = buildConfig([{ name: './not-a-dir.txt', alias: 'flat' }]);

    expect(() => buildRegistry(root, config, [])).toThrow(
      PluginResolutionError,
    );
  });

  it('throws when the plugin entry point has no default export function', () => {
    const dir = join(FIXTURE_ROOT, 'bad-export');
    const config = buildConfig([{ name: dir, alias: 'badexport' }]);

    expect(() => buildRegistry(makeRoot(), config, [])).toThrow(
      PluginResolutionError,
    );
  });

  it('wraps a factory that throws, preserving the cause', () => {
    const dir = join(FIXTURE_ROOT, 'throwing');
    const config = buildConfig([{ name: dir, alias: 'thrower' }]);

    try {
      buildRegistry(makeRoot(), config, []);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PluginResolutionError);
      expect((error as PluginResolutionError).cause).toBeInstanceOf(Error);
      expect(((error as PluginResolutionError).cause as Error).message).toBe(
        'boom',
      );
    }
  });

  it('throws when a plugin module id collides with a built-in', () => {
    ensureFixtureSelfLink();
    const builtIns = [stubModule('fixture/fixture-core')];
    const config = buildConfig([{ name: FIXTURE_ROOT, alias: 'fixture' }]);

    expect(() => buildRegistry(makeRoot(), config, builtIns)).toThrow(
      PluginResolutionError,
    );
  });

  it('throws when two plugins share an alias', () => {
    ensureFixtureSelfLink();
    const config = buildConfig([
      { name: FIXTURE_ROOT, alias: 'dup' },
      { name: 'this-package-is-never-reached', alias: 'dup' },
    ]);

    expect(() => buildRegistry(makeRoot(), config, [])).toThrow(
      PluginResolutionError,
    );
  });

  it("throws when a plugin's peer range excludes the running CLI version", () => {
    const dir = join(FIXTURE_ROOT, 'peer-mismatch');
    const config = buildConfig([{ name: dir, alias: 'peermismatch' }]);

    expect(() => buildRegistry(makeRoot(), config, [])).toThrow(
      PluginResolutionError,
    );
  });

  it('throws on a 0.x range whose minor excludes the CLI, where majors alone would match', () => {
    const dir = join(FIXTURE_ROOT, 'peer-zerox');
    const config = buildConfig([{ name: dir, alias: 'peerzerox' }]);

    expect(() => buildRegistry(makeRoot(), config, [])).toThrow(
      PluginResolutionError,
    );
  });

  it('accepts a workspace: peer range, which pnpm rewrites to a real version at publish', () => {
    const dir = join(FIXTURE_ROOT, 'peer-workspace');
    const config = buildConfig([{ name: dir, alias: 'peerworkspace' }]);

    expect(() => buildRegistry(makeRoot(), config, [])).not.toThrow();
  });

  it('throws on an unparseable peer range rather than treating it as satisfied', () => {
    const dir = join(FIXTURE_ROOT, 'peer-badrange');
    const config = buildConfig([{ name: dir, alias: 'peerbadrange' }]);

    expect(() => buildRegistry(makeRoot(), config, [])).toThrow(/unparseable/);
  });

  it('plans a copy of the CLI lib a plugin script imports, sourced from the CLI payload', () => {
    const config = buildConfig([{ name: LIBS_FIXTURE, alias: 'libs' }]);

    const registry = buildRegistry(makeRoot(), config, []);
    const actions = runPlan(registry.get('libs/libs')!.def);
    const derived = actions.find(
      (action) =>
        action.kind === 'copy' &&
        action.dest === '.claude/scripts/lib/entry-ledger.mjs',
    );

    expect(derived).toEqual({
      kind: 'copy',
      src: payloadPath('scripts', 'lib', 'entry-ledger.mjs'),
      dest: '.claude/scripts/lib/entry-ledger.mjs',
      module: 'libs',
      reason: 'shared script library',
    });
  });

  it('plans one lib copy when two scripts in the same module import it', () => {
    const config = buildConfig([{ name: LIBS_FIXTURE, alias: 'libs' }]);

    const registry = buildRegistry(makeRoot(), config, []);
    const actions = runPlan(registry.get('libs/libs')!.def);
    const libCopies = actions.filter(
      (action) =>
        action.kind === 'copy' &&
        action.dest === '.claude/scripts/lib/entry-ledger.mjs',
    );

    expect(libCopies).toHaveLength(1);
  });

  it('plans nothing extra for a script with no entry in the sidecar', () => {
    const config = buildConfig([{ name: LIBS_FIXTURE, alias: 'libs' }]);

    const registry = buildRegistry(makeRoot(), config, []);
    const actions = runPlan(registry.get('libs/libs')!.def);
    const libDests = actions
      .filter((action) => action.kind === 'copy')
      .map((action) => action.dest)
      .filter((dest) => dest.startsWith('.claude/scripts/lib/'));

    expect(libDests).toEqual(['.claude/scripts/lib/entry-ledger.mjs']);
  });

  it('plans no lib copies for a plugin whose payload has no import sidecar', () => {
    ensureFixtureSelfLink();
    const config = buildConfig([
      { name: FIXTURE_ROOT, alias: 'fixture', config: {} },
    ]);

    const registry = buildRegistry(makeRoot(), config, []);
    const actions = runPlan(registry.get('fixture/fixture-core')!.def);
    const libDests = actions
      .filter((action) => action.kind === 'copy')
      .map((action) => action.dest)
      .filter((dest) => dest.startsWith('.claude/scripts/lib/'));

    expect(libDests).toEqual([]);
  });

  it("resolves a derived lib copy inside the CLI's own payload-dist, not the plugin's package", () => {
    const config = buildConfig([{ name: LIBS_FIXTURE, alias: 'libs' }]);

    const registry = buildRegistry(makeRoot(), config, []);
    const actions = runPlan(registry.get('libs/libs')!.def);
    const derived = actions.find(
      (action): action is CopyAction =>
        action.kind === 'copy' &&
        action.dest === '.claude/scripts/lib/entry-ledger.mjs',
    );

    expect(derived?.src).toBe(
      payloadPath('scripts', 'lib', 'entry-ledger.mjs'),
    );
    expect(derived?.src.endsWith('.mjs')).toBe(true);
    expect(existsSync(derived!.src)).toBe(true);
  });

  it('plans a copy from a lib name the CLI payload does not actually ship, rather than dropping it', () => {
    const config = buildConfig([{ name: BAD_LIB_FIXTURE, alias: 'badlib' }]);

    const registry = buildRegistry(makeRoot(), config, []);
    const actions = runPlan(registry.get('badlib/bad-lib')!.def);
    const derived = actions.find(
      (action): action is CopyAction =>
        action.kind === 'copy' &&
        action.dest === '.claude/scripts/lib/nonexistent-lib.mjs',
    );

    expect(derived).toEqual({
      kind: 'copy',
      src: payloadPath('scripts', 'lib', 'nonexistent-lib.mjs'),
      dest: '.claude/scripts/lib/nonexistent-lib.mjs',
      module: 'bad-lib',
      reason: 'shared script library',
    });
    expect(existsSync(derived!.src)).toBe(false);
  });
});
