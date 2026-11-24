import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  MODULES,
  SHARED_HOST_FILES,
  buildPlan,
  classifyWrite,
  computeEffects,
  computePrune,
  defaultModuleIds,
  resolveModuleIds,
} from '../plan.js';
import { HouseError } from '../house-error.js';
import { payloadGitignoreActions } from '../modules/payload-gitignore.js';
import { hookCommand, hookFragment } from '@houserules/api';
import type {
  BodyAction,
  CopyAction,
  HookFragmentOptions,
  MergeSettingsAction,
  RegionAction,
  SeedAction,
  Settings,
  ModuleDef,
  WriteAction,
} from '@houserules/api';
import type { Effect } from '../plan.js';
import type {
  PluginSource,
  Registry,
  RegisteredModule,
} from '../plugin-registry.js';
import { makeAnswers, makeCtx, makeTarget } from '#test/ctx-builder';
import { sha256 } from '#test/installed-tree';

function makeRegistry(
  builtIns: ModuleDef[],
  plugins: RegisteredModule[] = [],
): Registry {
  const modules: RegisteredModule[] = [
    ...builtIns.map((def) => ({ id: def.id, def, source: null })),
    ...plugins,
  ];
  return {
    modules,
    plugins: [],
    get: (id) => modules.find((m) => m.id === id),
  };
}

const registry = makeRegistry(MODULES);

function single<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  return items[0]!;
}

describe('resolveModuleIds', () => {
  it('returns the defaults when no flag is given', () => {
    const ctx = makeCtx();
    expect(resolveModuleIds(ctx, registry)).toEqual(
      defaultModuleIds(ctx, registry),
    );
  });

  it('returns the defaults for an empty string flag', () => {
    const ctx = makeCtx();
    expect(resolveModuleIds(ctx, registry, '')).toEqual(
      defaultModuleIds(ctx, registry),
    );
  });

  it('adds a bare module id to the defaults', () => {
    const ctx = makeCtx();
    expect(resolveModuleIds(ctx, registry, 'reviewers')).toContain('reviewers');
  });

  it('removes a default module with a "-" prefix', () => {
    const ctx = makeCtx({ typescript: true });
    expect(defaultModuleIds(ctx, registry)).toContain('rename');
    expect(resolveModuleIds(ctx, registry, '-rename')).not.toContain('rename');
  });

  it('re-adds "core" even when "-core" is given, since core is always forced on', () => {
    const ctx = makeCtx();
    expect(resolveModuleIds(ctx, registry, '-core')).toContain('core');
  });

  it('adds a bare module id to the defaults rather than replacing them', () => {
    const ctx = makeCtx();
    const resolved = resolveModuleIds(ctx, registry, 'reviewers');

    expect(resolved).toEqual(
      expect.arrayContaining([...defaultModuleIds(ctx, registry), 'reviewers']),
    );
  });

  it('applies several comma-separated entries, mixing additions and removals', () => {
    const ctx = makeCtx({ typescript: true });
    const resolved = resolveModuleIds(ctx, registry, 'reviewers,-rename');
    expect(resolved).toContain('reviewers');
    expect(resolved).not.toContain('rename');
  });

  it('trims whitespace around comma-separated entries', () => {
    const ctx = makeCtx();
    expect(
      resolveModuleIds(ctx, registry, ' reviewers , debug-session '),
    ).toEqual(expect.arrayContaining(['reviewers', 'debug-session']));
  });

  it('ignores an empty entry produced by a trailing or doubled comma', () => {
    const ctx = makeCtx();
    expect(resolveModuleIds(ctx, registry, 'reviewers,,')).toEqual(
      resolveModuleIds(ctx, registry, 'reviewers'),
    );
  });

  it('returns ids in MODULES registry order regardless of flag order', () => {
    const ctx = makeCtx();
    const resolved = resolveModuleIds(ctx, registry, 'sweep,reviewers');
    const registryOrder = MODULES.map((m) => m.id).filter((id) =>
      resolved.includes(id),
    );
    expect(resolved).toEqual(registryOrder);
  });

  it('throws a HouseError naming the offending id for an unknown module', () => {
    const ctx = makeCtx();
    expect(() => resolveModuleIds(ctx, registry, 'nope')).toThrow(HouseError);
    expect(() => resolveModuleIds(ctx, registry, 'nope')).toThrow(
      /Unknown module "nope"/,
    );
  });

  it('lists the known module ids in the unknown-module error message', () => {
    const ctx = makeCtx();
    try {
      resolveModuleIds(ctx, registry, 'nope');
      throw new Error('expected resolveModuleIds to throw');
    } catch (e) {
      expect((e as Error).message).toContain('core');
    }
  });

  it('throws on an unknown id even when it carries a "-" prefix', () => {
    const ctx = makeCtx();
    expect(() => resolveModuleIds(ctx, registry, '-nope')).toThrow(
      /Unknown module "nope"/,
    );
  });
});

describe('defaultModuleIds', () => {
  it('includes "rename" only when TypeScript is detected', () => {
    expect(
      defaultModuleIds(makeCtx({ typescript: false }), registry),
    ).not.toContain('rename');
    expect(defaultModuleIds(makeCtx({ typescript: true }), registry)).toContain(
      'rename',
    );
  });

  it('includes "lint-fix" only when a target declares fix commands', () => {
    const noFix = makeCtx({ targets: [makeTarget({ fixCommands: null })] });
    const withFix = makeCtx({
      targets: [makeTarget({ fixCommands: ['eslint --fix'] })],
    });
    expect(defaultModuleIds(noFix, registry)).not.toContain('lint-fix');
    expect(defaultModuleIds(withFix, registry)).toContain('lint-fix');
  });

  it('always includes "core"', () => {
    expect(defaultModuleIds(makeCtx(), registry)).toContain('core');
  });
});

describe('buildPlan, given a registry with a plugin-contributed module', () => {
  const pluginDef: ModuleDef = {
    id: 'extra',
    title: 'Extra',
    group: 'optional',
    hint: () => 'extra',
    defaultEnabled: () => false,
    plan: () => [
      {
        kind: 'write',
        module: 'extra',
        dest: '.claude/plugin-extra.md',
        content: 'from the plugin\n',
        reason: 'plugin-contributed file',
      },
    ],
  };
  const source: RegisteredModule['source'] = {
    name: 'demo-plugin',
    alias: 'demo',
    version: '1.0.0',
    dir: '/plugins/demo',
  };

  it('selects the plugin module by its namespaced id and skips built-ins not requested', () => {
    const withPlugin = makeRegistry(MODULES, [
      { id: 'demo/extra', def: pluginDef, source },
    ]);
    const ctx = makeCtx();
    const answers = makeAnswers({ moduleIds: ['core', 'demo/extra'] });

    const actions = buildPlan(ctx, answers, withPlugin);

    expect(actions).toContainEqual(
      expect.objectContaining({ dest: '.claude/plugin-extra.md' }),
    );
  });

  it('lists the plugin-contributed .claude/ dest in the .claude/.gitignore block', () => {
    const withPlugin = makeRegistry(MODULES, [
      { id: 'demo/extra', def: pluginDef, source },
    ]);

    const actions = buildPlan(
      makeCtx(),
      makeAnswers({ moduleIds: ['core', 'demo/extra'] }),
      withPlugin,
    );

    const block = single(
      actions.filter(
        (a): a is RegionAction =>
          a.kind === 'region' && a.dest === '.claude/.gitignore',
      ),
    );
    expect(block.body.split('\n')).toContain('/plugin-extra.md');
  });
});

describe('SHARED_HOST_FILES', () => {
  it('contains exactly the six user-owned, region-managed paths', () => {
    expect(SHARED_HOST_FILES).toEqual(
      new Set([
        '.claude/settings.json',
        'CLAUDE.md',
        'AGENTS.md',
        '.gitignore',
        '.prettierignore',
        '.claude/.gitignore',
      ]),
    );
  });
});

describe('classifyWrite', () => {
  const canonical = Buffer.from('canonical content', 'utf8');

  it('creates a file that does not exist yet', () => {
    expect(
      classifyWrite({
        exists: false,
        onDisk: null,
        canonical,
        recordedHash: undefined,
        force: false,
      }),
    ).toBe('create');
  });

  it('creates when onDisk is null even if exists is somehow true, since both are required to read the disk', () => {
    expect(
      classifyWrite({
        exists: true,
        onDisk: null,
        canonical,
        recordedHash: sha256(canonical),
        force: false,
      }),
    ).toBe('create');
  });

  it('skips as identical when the on-disk bytes already match canonical', () => {
    expect(
      classifyWrite({
        exists: true,
        onDisk: Buffer.from('canonical content', 'utf8'),
        canonical,
        recordedHash: undefined,
        force: false,
      }),
    ).toBe('skip-identical');
  });

  it('skips as identical even when a stale recordedHash disagrees, since matching bytes outrank the manifest', () => {
    expect(
      classifyWrite({
        exists: true,
        onDisk: Buffer.from('canonical content', 'utf8'),
        canonical,
        recordedHash: sha256(Buffer.from('some other hash source')),
        force: false,
      }),
    ).toBe('skip-identical');
  });

  it('refreshes a file only houserules has written, since a hash match means you never touched it', () => {
    const onDisk = Buffer.from('old houserules content', 'utf8');
    expect(
      classifyWrite({
        exists: true,
        onDisk,
        canonical,
        recordedHash: sha256(onDisk),
        force: false,
      }),
    ).toBe('update');
  });

  it('skips a file you edited, since its bytes no longer match the hash houserules recorded', () => {
    const onDisk = Buffer.from('your local edit', 'utf8');
    expect(
      classifyWrite({
        exists: true,
        onDisk,
        canonical,
        recordedHash: sha256(Buffer.from('what houserules originally wrote')),
        force: false,
      }),
    ).toBe('skip-modified');
  });

  it('overwrites a file you edited when force is set', () => {
    const onDisk = Buffer.from('your local edit', 'utf8');
    expect(
      classifyWrite({
        exists: true,
        onDisk,
        canonical,
        recordedHash: sha256(Buffer.from('what houserules originally wrote')),
        force: true,
      }),
    ).toBe('update');
  });

  it('updates an unmanaged file houserules never wrote, since there is nothing recorded to have diverged from', () => {
    expect(
      classifyWrite({
        exists: true,
        onDisk: Buffer.from('unmanaged content', 'utf8'),
        canonical,
        recordedHash: undefined,
        force: false,
      }),
    ).toBe('update');
  });

  it('updates an unmanaged file identically whether force is true or false, since force only affects locally-modified files', () => {
    const args = {
      exists: true,
      onDisk: Buffer.from('unmanaged content', 'utf8'),
      canonical,
      recordedHash: undefined,
    };
    expect(classifyWrite({ ...args, force: false })).toBe('update');
    expect(classifyWrite({ ...args, force: true })).toBe('update');
  });

  it('creates an empty file that does not exist', () => {
    expect(
      classifyWrite({
        exists: false,
        onDisk: null,
        canonical: Buffer.from(''),
        recordedHash: undefined,
        force: false,
      }),
    ).toBe('create');
  });

  it('skips as identical when both the on-disk file and canonical content are empty', () => {
    expect(
      classifyWrite({
        exists: true,
        onDisk: Buffer.from(''),
        canonical: Buffer.from(''),
        recordedHash: undefined,
        force: false,
      }),
    ).toBe('skip-identical');
  });

  it('refreshes an empty on-disk file that only houserules wrote, matching the recorded hash of empty content', () => {
    const onDisk = Buffer.from('');
    expect(
      classifyWrite({
        exists: true,
        onDisk,
        canonical: Buffer.from('now has content', 'utf8'),
        recordedHash: sha256(onDisk),
        force: false,
      }),
    ).toBe('update');
  });
});

describe('computeEffects, given a "body" action', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-body-'));
    dirs.push(dir);
    return dir;
  }

  function writeFile(root: string, rel: string, content: string): string {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  }

  const SHIPPED_FRONTMATTER = '---\ndescription: shipped rule\n---\n';
  const SHIPPED_BODY = 'Line one.\nLine two.\n';
  const SHIPPED = SHIPPED_FRONTMATTER + SHIPPED_BODY;

  function bodyAction(src: string): BodyAction {
    return {
      kind: 'body',
      module: 'test',
      src,
      dest: 'rules/example.md',
      reason: 'test',
    };
  }

  it('creates the whole payload file, frontmatter included, when the dest is absent', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const src = writeFile(payloadDir, 'example.md', SHIPPED);
    const action = bodyAction(src);

    const { effects } = computeEffects(root, [action]);
    const effect = single(effects);

    expect(effects).toHaveLength(1);
    expect(effect.op).toBe('create');
    expect(effect.content?.toString('utf8')).toBe(SHIPPED);
    expect(effect.hash).toBe(sha256(SHIPPED_BODY));
    expect(effect.frontmatterHash).toBe(sha256(SHIPPED_FRONTMATTER));
  });

  it('appends appendBody below the payload body and hashes the pair together', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const src = writeFile(payloadDir, 'example.md', SHIPPED);
    const tail = '\n## Also installed\n\n- `../reference/optional.md`\n';
    const action = { ...bodyAction(src), appendBody: tail };

    const { effects } = computeEffects(root, [action]);
    const effect = single(effects);

    expect(effect.content?.toString('utf8')).toBe(SHIPPED + tail);
    expect(effect.hash).toBe(sha256(SHIPPED_BODY + tail));
    expect(effect.frontmatterHash).toBe(sha256(SHIPPED_FRONTMATTER));
  });

  it('refreshes an installed rule whose appendBody changed, since the selection that composed it did', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const src = writeFile(payloadDir, 'example.md', SHIPPED);
    writeFile(root, 'rules/example.md', SHIPPED);
    const action = { ...bodyAction(src), appendBody: '\nnew routing line\n' };

    const { effects } = computeEffects(root, [action]);
    const effect = single(effects);

    expect(effect.op).toBe('update');
    expect(effect.content?.toString('utf8')).toBe(
      SHIPPED + '\nnew routing line\n',
    );
  });

  it('skips as identical when the disk body matches the canonical body, whatever the disk frontmatter says', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const src = writeFile(payloadDir, 'example.md', SHIPPED);
    const customFrontmatter =
      '---\ndescription: customized\npaths:\n  - "*.ts"\n---\n';
    writeFile(root, 'rules/example.md', customFrontmatter + SHIPPED_BODY);
    const action = bodyAction(src);

    const { effects } = computeEffects(root, [action]);
    const effect = single(effects);

    expect(effect.op).toBe('skip-identical');
    expect(effect.content?.toString('utf8')).toBe(
      customFrontmatter + SHIPPED_BODY,
    );
  });

  it('splices the canonical body under the disk frontmatter on update', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const src = writeFile(payloadDir, 'example.md', SHIPPED);
    const customFrontmatter =
      '---\ndescription: customized\npaths:\n  - "*.ts"\n---\n';
    writeFile(root, 'rules/example.md', customFrontmatter + 'Old body.\n');
    const action = bodyAction(src);

    const { effects } = computeEffects(root, [action]);
    const effect = single(effects);

    expect(effect.op).toBe('update');
    expect(effect.content?.toString('utf8')).toBe(
      customFrontmatter + SHIPPED_BODY,
    );
  });

  it('skips as modified when the disk body diverges from the recorded body hash', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const src = writeFile(payloadDir, 'example.md', SHIPPED);
    const editedBody = 'Edited by hand.\n';
    writeFile(root, 'rules/example.md', SHIPPED_FRONTMATTER + editedBody);
    const action = bodyAction(src);
    const manifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['test'],
      files: {
        'rules/example.md': {
          body: sha256('Some previously written body.\n'),
          frontmatter: sha256(SHIPPED_FRONTMATTER),
        },
      },
    };

    const { effects } = computeEffects(root, [action], { manifest });
    const effect = single(effects);

    expect(effect.op).toBe('skip-modified');
  });

  it('overwrites a body-modified file when force is set', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const src = writeFile(payloadDir, 'example.md', SHIPPED);
    const editedBody = 'Edited by hand.\n';
    writeFile(root, 'rules/example.md', SHIPPED_FRONTMATTER + editedBody);
    const action = bodyAction(src);
    const manifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['test'],
      files: {
        'rules/example.md': {
          body: sha256('Some previously written body.\n'),
          frontmatter: sha256(SHIPPED_FRONTMATTER),
        },
      },
    };

    const { effects } = computeEffects(root, [action], {
      manifest,
      force: true,
    });
    const effect = single(effects);

    expect(effect.op).toBe('update');
    expect(effect.content?.toString('utf8')).toBe(
      SHIPPED_FRONTMATTER + SHIPPED_BODY,
    );
  });

  it('adopts an untouched legacy whole-file manifest entry as unmodified, refreshing its body', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const src = writeFile(payloadDir, 'example.md', SHIPPED);
    const oldShipped = SHIPPED_FRONTMATTER + 'Old shipped body.\n';
    writeFile(root, 'rules/example.md', oldShipped);
    const action = bodyAction(src);
    const manifest = {
      kitVersion: '0.9.0',
      installedAt: '2025-01-01T00:00:00.000Z',
      modules: ['test'],
      files: {
        'rules/example.md': sha256(oldShipped),
      },
    };

    const { effects } = computeEffects(root, [action], { manifest });
    const effect = single(effects);

    expect(effect.op).toBe('update');
    expect(effect.content?.toString('utf8')).toBe(
      SHIPPED_FRONTMATTER + SHIPPED_BODY,
    );
  });

  it('skips as modified when a legacy whole-file entry no longer matches the disk file', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const src = writeFile(payloadDir, 'example.md', SHIPPED);
    const oldShipped = SHIPPED_FRONTMATTER + 'Old shipped body.\n';
    writeFile(
      root,
      'rules/example.md',
      SHIPPED_FRONTMATTER + 'Hand-edited body.\n',
    );
    const action = bodyAction(src);
    const manifest = {
      kitVersion: '0.9.0',
      installedAt: '2025-01-01T00:00:00.000Z',
      modules: ['test'],
      files: {
        'rules/example.md': sha256(oldShipped),
      },
    };

    const { effects } = computeEffects(root, [action], { manifest });
    const effect = single(effects);

    expect(effect.op).toBe('skip-modified');
  });

  it('silently replaces an untouched frontmatter with the shipped default when houserules moved it on', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const newShippedFrontmatter = '---\ndescription: shipped rule v2\n---\n';
    const newShippedBody = 'New line one.\n';
    const src = writeFile(
      payloadDir,
      'example.md',
      newShippedFrontmatter + newShippedBody,
    );
    writeFile(root, 'rules/example.md', SHIPPED_FRONTMATTER + SHIPPED_BODY);
    const action = bodyAction(src);
    const manifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['test'],
      files: {
        'rules/example.md': {
          body: sha256(SHIPPED_BODY),
          frontmatter: sha256(SHIPPED_FRONTMATTER),
        },
      },
    };

    const { effects } = computeEffects(root, [action], { manifest });
    const effect = single(effects);

    expect(effect.op).toBe('update');
    expect(effect.content?.toString('utf8')).toBe(
      newShippedFrontmatter + newShippedBody,
    );
  });

  it('preserves a customized frontmatter byte for byte even when the shipped default has moved on', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const newShippedFrontmatter = '---\ndescription: shipped rule v2\n---\n';
    const src = writeFile(
      payloadDir,
      'example.md',
      newShippedFrontmatter + SHIPPED_BODY,
    );
    const customFrontmatter =
      '---\ndescription: customized\npaths:\n  - "*.ts"\n---\n';
    writeFile(root, 'rules/example.md', customFrontmatter + SHIPPED_BODY);
    const action = bodyAction(src);
    const manifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['test'],
      files: {
        'rules/example.md': {
          body: sha256(SHIPPED_BODY),
          frontmatter: sha256(SHIPPED_FRONTMATTER),
        },
      },
    };

    const { effects } = computeEffects(root, [action], { manifest });
    const effect = single(effects);

    expect(effect.content?.toString('utf8')).toBe(
      customFrontmatter + SHIPPED_BODY,
    );
  });

  it('refreshes as an "update", not "skip-identical", when only the untouched frontmatter needs to change', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const newShippedFrontmatter = '---\ndescription: shipped rule v2\n---\n';
    const src = writeFile(
      payloadDir,
      'example.md',
      newShippedFrontmatter + SHIPPED_BODY,
    );
    writeFile(root, 'rules/example.md', SHIPPED_FRONTMATTER + SHIPPED_BODY);
    const action = bodyAction(src);
    const manifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['test'],
      files: {
        'rules/example.md': {
          body: sha256(SHIPPED_BODY),
          frontmatter: sha256(SHIPPED_FRONTMATTER),
        },
      },
    };

    const { effects } = computeEffects(root, [action], { manifest });
    const effect = single(effects);

    expect(effect.op).toBe('update');
    expect(effect.content?.toString('utf8')).toBe(
      newShippedFrontmatter + SHIPPED_BODY,
    );
  });

  it('throws a HouseError naming the payload path when the src is missing', () => {
    const root = tempDir();
    const action = bodyAction(join(tempDir(), 'nonexistent.md'));

    expect(() => computeEffects(root, [action])).toThrow(HouseError);
  });
});

describe('computeEffects, given a plugin-sourced action whose payload file is missing', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-broken-plugin-'));
    dirs.push(dir);
    return dir;
  }

  function pluginSource(
    dir: string,
    name = '@houserules/plugin-demo',
  ): PluginSource {
    return { name, alias: 'demo', version: '1.0.0', dir };
  }

  function missingAction(pluginDir: string): BodyAction {
    return {
      kind: 'body',
      module: 'demo',
      src: join(pluginDir, 'payload-dist', 'rules', 'missing.md'),
      dest: 'rules/missing.md',
      reason: 'test',
    };
  }

  it('names the plugin that owns the missing payload file, instead of aborting', () => {
    const root = tempDir();
    const pluginDir = tempDir();
    const action = missingAction(pluginDir);

    const { brokenPlugins, effects } = computeEffects(root, [action], {
      plugins: [pluginSource(pluginDir)],
    });
    const brokenPlugin = single(brokenPlugins);

    expect(brokenPlugins).toHaveLength(1);
    expect(brokenPlugin.plugin).toBe('@houserules/plugin-demo');
    expect(brokenPlugin.message).toContain('@houserules/plugin-demo');
    expect(brokenPlugin.message).toContain(action.src);
    expect(effects).toHaveLength(0);
  });

  it('tells the user a payload build produces the missing file', () => {
    const root = tempDir();
    const pluginDir = tempDir();
    const action = missingAction(pluginDir);

    const { brokenPlugins } = computeEffects(root, [action], {
      plugins: [pluginSource(pluginDir)],
    });
    const brokenPlugin = single(brokenPlugins);

    expect(brokenPlugin.message).toMatch(/payload/i);
    expect(brokenPlugin.message).toMatch(/build/i);
  });

  it("still renders a healthy sibling plugin's plan", () => {
    const root = tempDir();
    const brokenPluginDir = tempDir();
    const healthyPluginDir = tempDir();
    const healthySrc = join(healthyPluginDir, 'payload-dist', 'ok.md');
    mkdirSync(dirname(healthySrc), { recursive: true });
    writeFileSync(healthySrc, 'healthy content\n');
    const brokenPluginAction = missingAction(brokenPluginDir);
    const healthyAction: CopyAction = {
      kind: 'copy',
      module: 'ok',
      src: healthySrc,
      dest: 'ok.md',
      reason: 'test',
    };

    const { brokenPlugins, effects } = computeEffects(
      root,
      [brokenPluginAction, healthyAction],
      {
        plugins: [
          pluginSource(brokenPluginDir, '@houserules/plugin-broken'),
          pluginSource(healthyPluginDir, '@houserules/plugin-ok'),
        ],
      },
    );
    const effect = single(effects);

    expect(brokenPlugins).toHaveLength(1);
    expect(effects).toHaveLength(1);
    expect(effect.action.dest).toBe('ok.md');
    expect(effect.op).toBe('create');
  });
});

describe('computePrune, given a retired body-owned dest', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-prune-body-'));
    dirs.push(dir);
    return dir;
  }

  function writeFile(root: string, rel: string, content: string): void {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  it('deletes it when the disk body still matches the recorded body hash', () => {
    const root = tempDir();
    const frontmatter = '---\ndescription: retired\n---\n';
    const body = 'Retired body.\n';
    writeFile(root, 'rules/retired.md', frontmatter + body);
    const manifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: [],
      files: {
        'rules/retired.md': {
          body: sha256(body),
          frontmatter: sha256(frontmatter),
        },
      },
    };

    const { deletes, kept } = computePrune(root, {
      manifest,
      plannedDests: new Set(),
    });

    expect(deletes).toEqual([{ dest: 'rules/retired.md', modified: false }]);
    expect(kept).toEqual([]);
  });

  it('keeps it when the disk body was locally edited', () => {
    const root = tempDir();
    const frontmatter = '---\ndescription: retired\n---\n';
    writeFile(root, 'rules/retired.md', frontmatter + 'Hand-edited body.\n');
    const manifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: [],
      files: {
        'rules/retired.md': {
          body: sha256('Original body.\n'),
          frontmatter: sha256(frontmatter),
        },
      },
    };

    const { deletes, kept } = computePrune(root, {
      manifest,
      plannedDests: new Set(),
    });

    expect(deletes).toEqual([]);
    expect(kept).toEqual(['rules/retired.md']);
  });
});

describe('buildPlan, for a module declaring options', () => {
  const OPTION_MODULE_ID = 'langs/fixture-langs';
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function languageModule(): ModuleDef {
    return {
      id: 'fixture-langs',
      title: 'Fixture Languages',
      group: 'optional',
      hint: () => 'options fixture',
      defaultEnabled: () => true,
      options: {
        prompt: 'Which languages?',
        choices: [
          { value: 'alpha', label: 'Alpha' },
          { value: 'beta', label: 'Beta' },
        ],
        defaults: ['alpha'],
      },
      plan: (_ctx, answers) =>
        (answers.moduleOptions[OPTION_MODULE_ID] ?? []).map((value) => ({
          kind: 'write' as const,
          module: 'fixture-langs',
          dest: `.claude/lang-${value}.md`,
          content: `${value}\n`,
          reason: `option ${value}`,
        })),
    };
  }

  function registryWithOptionModule(): Registry {
    const modules: RegisteredModule[] = [
      {
        id: OPTION_MODULE_ID,
        def: languageModule(),
        source: {
          name: 'fixture',
          alias: 'langs',
          version: '0.0.0',
          dir: '/nowhere',
        },
      },
    ];
    return {
      modules,
      plugins: [],
      get: (id) => modules.find((m) => m.id === id),
    };
  }

  function destsFor(selected: string[]): string[] {
    const actions = buildPlan(
      makeCtx(),
      makeAnswers({
        moduleIds: [OPTION_MODULE_ID],
        moduleOptions: { [OPTION_MODULE_ID]: selected },
      }),
      registryWithOptionModule(),
    );
    return actions
      .filter((a) => a.kind === 'write')
      .map((a) => a.dest)
      .filter((dest) => dest.startsWith('.claude/lang-'));
  }

  it('plans one dest per selected option value', () => {
    expect(destsFor(['alpha', 'beta'])).toEqual([
      '.claude/lang-alpha.md',
      '.claude/lang-beta.md',
    ]);
  });

  it('plans nothing for a module whose options were all deselected', () => {
    expect(destsFor([])).toEqual([]);
  });

  it("retires a deselected value's file, so prune deletes exactly that one", () => {
    const root = mkdtempSync(join(tmpdir(), 'kit-options-'));
    dirs.push(root);
    writeFileSync(join(root, 'alpha.md'), 'alpha\n');
    const manifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: [OPTION_MODULE_ID],
      files: { 'alpha.md': sha256('alpha\n') },
    };

    const { deletes } = computePrune(root, {
      manifest,
      plannedDests: new Set(destsFor(['beta'])),
    });

    expect(deletes.map((d) => d.dest)).toEqual(['alpha.md']);
  });
});

describe('computeEffects, given a "region" action on a padded region', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-region-'));
    dirs.push(dir);
    return dir;
  }

  const CURRENT = {
    id: 'claude-md',
    start: '<!-- houserules:claude-md start -->',
    end: '<!-- houserules:claude-md end -->',
    anchor: 'after-h1' as const,
    pad: true,
    legacy: {
      start: '<!-- claude-kit:claude-md start -->',
      end: '<!-- claude-kit:claude-md end -->',
    },
  };

  function regionAction(body: string) {
    return {
      kind: 'region' as const,
      module: 'core',
      dest: 'CLAUDE.md',
      body,
      region: CURRENT,
      reason: 'test',
    };
  }

  function hostFile(
    root: string,
    markers: { start: string; end: string },
    body: string,
  ): void {
    writeFileSync(
      join(root, 'CLAUDE.md'),
      `# Title\n\n${markers.start}\n\n${body}\n\n${markers.end}\n\nUser prose below.\n`,
    );
  }

  function manifestRecording(hash: string) {
    return {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['core'],
      files: { 'CLAUDE.md': hash },
    };
  }

  it('refreshes a changed body rather than calling the padding a local edit', () => {
    const root = tempDir();
    hostFile(root, CURRENT, 'old body');

    const { effects } = computeEffects(root, [regionAction('new body')], {
      manifest: manifestRecording(sha256('old body')),
    });
    const effect = single(effects);

    expect(effect.op).toBe('update');
  });

  it('carries the old body on an update and none on a create', () => {
    const root = tempDir();
    hostFile(root, CURRENT, 'old body');
    const updated = single(
      computeEffects(root, [regionAction('new body')], {
        manifest: manifestRecording(sha256('old body')),
      }).effects,
    );
    expect(updated.op).toBe('update');
    expect(updated.previousBody?.trim()).toBe('old body');

    const fresh = tempDir();
    const created = single(
      computeEffects(fresh, [regionAction('new body')]).effects,
    );
    expect(created.op).toBe('create');
    expect(created.previousBody).toBeUndefined();
  });

  it('plans an update with no previousBody for a host file that has no block yet', () => {
    const root = tempDir();
    writeFileSync(join(root, 'CLAUDE.md'), '# Title\n\nUser prose.\n');
    const effect = single(
      computeEffects(root, [regionAction('new body')]).effects,
    );
    expect(effect.op).toBe('update');
    expect(effect.previousBody).toBeUndefined();
  });

  it('still refuses a body the user edited', () => {
    const root = tempDir();
    hostFile(root, CURRENT, 'body the user rewrote');

    const { effects } = computeEffects(root, [regionAction('new body')], {
      manifest: manifestRecording(sha256('what houserules last wrote')),
    });
    const effect = single(effects);

    expect(effect.op).toBe('skip-modified');
  });

  it('adopts a block under legacy markers even though no recorded hash can match it', () => {
    const root = tempDir();
    hostFile(
      root,
      CURRENT.legacy,
      'body written by the previous houserules generation',
    );

    const { effects } = computeEffects(root, [regionAction('new body')], {
      manifest: manifestRecording('a-hash-from-another-codebase'),
    });
    const effect = single(effects);

    expect(effect.op).toBe('update');
  });

  it('leaves no legacy marker behind once it adopts', () => {
    const root = tempDir();
    hostFile(root, CURRENT.legacy, 'old');

    const { effects } = computeEffects(root, [regionAction('new body')], {
      manifest: manifestRecording('a-hash-from-another-codebase'),
    });
    const effect = single(effects);

    expect(effect.content!.toString()).not.toContain('claude-kit:claude-md');
  });

  it('preserves every byte outside the markers when adopting', () => {
    const root = tempDir();
    hostFile(root, CURRENT.legacy, 'old');

    const { effects } = computeEffects(root, [regionAction('new body')], {
      manifest: manifestRecording('a-hash-from-another-codebase'),
    });
    const effect = single(effects);

    const written = effect.content!.toString();
    expect(written.slice(0, '# Title\n'.length)).toBe('# Title\n');
    expect(written.slice(-'\nUser prose below.\n'.length)).toBe(
      '\nUser prose below.\n',
    );
  });
});

describe('computeEffects, given a "seed" action with managedKeys', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-seed-'));
    dirs.push(dir);
    return dir;
  }

  const CONFIG_DEST = '.claude/houserules.config.json';
  const SELECTION = { 'langs/fixture': ['beta'] };

  function seedAction(): SeedAction {
    return {
      kind: 'seed',
      module: 'core',
      dest: CONFIG_DEST,
      content: `${JSON.stringify({ version: 2, moduleOptions: SELECTION }, null, 2)}\n`,
      reason: 'per-repo houserules config',
      managedKeys: ['moduleOptions'],
    };
  }

  function writeExistingConfig(
    root: string,
    config: Record<string, unknown>,
  ): void {
    const abs = join(root, CONFIG_DEST);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(config, null, 2)}\n`);
  }

  it('creates the whole file when the config is absent', () => {
    const root = tempDir();

    const { effects } = computeEffects(root, [seedAction()]);
    const effect = single(effects);

    expect(effect.op).toBe('create');
  });

  it('reports a merge when the config exists, so the preview shows the write', () => {
    const root = tempDir();
    writeExistingConfig(root, { version: 2, packageManager: 'pnpm' });

    const { effects } = computeEffects(root, [seedAction()]);
    const effect = single(effects);

    expect(effect.op).toBe('merge');
  });

  it('writes the resolved selection into a config the user already has', () => {
    const root = tempDir();
    writeExistingConfig(root, { version: 2, packageManager: 'pnpm' });

    const { effects } = computeEffects(root, [seedAction()]);
    const effect = single(effects);

    const written = JSON.parse(effect.content!.toString());
    expect(written.moduleOptions).toEqual(SELECTION);
  });

  it('preserves the keys houserules does not manage', () => {
    const root = tempDir();
    writeExistingConfig(root, {
      version: 2,
      packageManager: 'pnpm',
      plugins: [{ name: '../p', alias: 'p' }],
    });

    const { effects } = computeEffects(root, [seedAction()]);
    const effect = single(effects);

    const written = JSON.parse(effect.content!.toString());
    expect(written.packageManager).toBe('pnpm');
    expect(written.plugins).toEqual([{ name: '../p', alias: 'p' }]);
  });

  it('leaves the file untouched when the managed key already matches', () => {
    const root = tempDir();
    writeExistingConfig(root, { version: 2, moduleOptions: SELECTION });

    const { effects } = computeEffects(root, [seedAction()]);
    const effect = single(effects);

    expect(effect.op).toBe('skip-exists');
  });

  it('leaves a seed without managedKeys alone when the dest exists', () => {
    const root = tempDir();
    writeExistingConfig(root, { version: 2 });
    const { managedKeys: _managedKeys, ...action } = seedAction();

    const { effects } = computeEffects(root, [action]);
    const effect = single(effects);

    expect(effect.op).toBe('skip-exists');
  });

  it('counts the config among plannedDests so prune never retires it', () => {
    const root = tempDir();
    writeExistingConfig(root, { version: 2 });

    const { plannedDests } = computeEffects(root, [seedAction()]);

    expect(plannedDests).toContain(CONFIG_DEST);
  });
});

describe('computeEffects, given two copy actions on one destination', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-copy-'));
    dirs.push(dir);
    return dir;
  }

  function writeLib(root: string, rel: string, content: string): string {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  }

  const LIB_DEST = '.claude/scripts/lib/entry-ledger.mjs';

  function libCopy(src: string, module: string): CopyAction {
    return {
      kind: 'copy',
      src,
      dest: LIB_DEST,
      module,
      reason: 'shared script library',
    };
  }

  function copiesTo(effects: { action: { dest: string } }[]): unknown[] {
    return effects.filter((effect) => effect.action.dest === LIB_DEST);
  }

  it('plans one write when core and a plugin derive the same lib from the same source', () => {
    const payload = tempDir();
    const src = writeLib(
      payload,
      'entry-ledger.mjs',
      'export const ledger = 1;\n',
    );

    const { effects } = computeEffects(tempDir(), [
      libCopy(src, 'core'),
      libCopy(src, 'backlog'),
    ]);
    expect(copiesTo(effects)).toHaveLength(1);
  });

  it('attributes the surviving write to the first action, so core keeps the lib', () => {
    const payload = tempDir();
    const src = writeLib(
      payload,
      'entry-ledger.mjs',
      'export const ledger = 1;\n',
    );

    const { effects } = computeEffects(tempDir(), [
      libCopy(src, 'core'),
      libCopy(src, 'backlog'),
    ]);
    const effect = single(effects);

    expect(effect.action.module).toBe('core');
  });

  it('plans both writes when two different sources claim one destination', () => {
    const payload = tempDir();
    const shipped = writeLib(
      payload,
      'cli/entry-ledger.mjs',
      'export const ledger = 1;\n',
    );
    const forged = writeLib(
      payload,
      'other/entry-ledger.mjs',
      'export const ledger = 2;\n',
    );

    const { effects } = computeEffects(tempDir(), [
      libCopy(shipped, 'core'),
      libCopy(forged, 'backlog'),
    ]);
    expect(copiesTo(effects)).toHaveLength(2);
  });
});

describe('computeEffects, given a merge-settings action and a malformed settings.json', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-settings-parse-'));
    dirs.push(dir);
    return dir;
  }

  function fragmentAction(): MergeSettingsAction {
    return {
      kind: 'merge-settings',
      module: 'core',
      fragment: { permissions: { allow: ['Read(**)'] } },
    };
  }

  it('throws a HouseError naming the JSON parse failure', () => {
    const root = tempDir();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), '{ not json');

    expect(() => computeEffects(root, [fragmentAction()])).toThrow(
      /\.claude\/settings\.json is not valid JSON/,
    );
  });
});

describe('computeEffects, given merge-settings actions carrying hooks', () => {
  const dirs: string[] = [];
  const DISPATCH_GUARD = hookCommand('hook-dispatch.mjs', 'guard');

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-dispatch-'));
    dirs.push(dir);
    return dir;
  }

  function hookAction(
    event: string,
    matcher: string | null,
    script: string,
    options?: HookFragmentOptions,
  ): MergeSettingsAction {
    return {
      kind: 'merge-settings',
      module: 'core',
      fragment: hookFragment(event, matcher, script, undefined, options),
    };
  }

  function seedSettings(root: string, settings: Settings): void {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'settings.json'),
      `${JSON.stringify(settings, null, 2)}\n`,
    );
  }

  function plannedSettings(root: string, actions: MergeSettingsAction[]) {
    const { settingsPlan } = computeEffects(root, actions);
    return JSON.parse(settingsPlan!.text!) as Settings;
  }

  function plannedWiring(actions: MergeSettingsAction[]): unknown {
    const { effects } = computeEffects(tempDir(), actions);
    const effect = effects.find(
      (e) => e.action.dest === '.claude/scripts/hook-wiring.json',
    );
    return JSON.parse(effect!.content!.toString('utf8'));
  }

  describe('over settings that carry a user-edited variant of guard-bash', () => {
    const EDITED_COMMAND = `${hookCommand('guard-bash.mjs', 'guard')} --my-extra-flag`;
    const EDITED_SETTINGS: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: EDITED_COMMAND }],
          },
        ],
      },
    };
    const actions = [
      hookAction('PreToolUse', 'Bash', 'guard-bash.mjs'),
      hookAction('PreToolUse', 'Read', 'guard-read.mjs'),
    ];

    function plannedWiringOver(root: string): {
      events: Record<string, { script: string }[]>;
    } {
      const { effects } = computeEffects(root, actions);
      const effect = effects.find(
        (e) => e.action.dest === '.claude/scripts/hook-wiring.json',
      );
      return JSON.parse(effect!.content!.toString('utf8'));
    }

    it('leaves guard-bash out of the PreToolUse wiring', () => {
      const root = tempDir();
      seedSettings(root, EDITED_SETTINGS);

      expect(plannedWiringOver(root).events.PreToolUse).toEqual([
        { script: 'guard-read.mjs', matcher: 'Read' },
      ]);
    });

    it('keeps the edited entry in settings byte for byte beside the dispatcher', () => {
      const root = tempDir();
      seedSettings(root, EDITED_SETTINGS);

      const commands = (
        plannedSettings(root, actions).hooks?.PreToolUse ?? []
      ).flatMap((group) => group.hooks.map((hook) => hook.command));

      expect(commands.sort()).toEqual([DISPATCH_GUARD, EDITED_COMMAND].sort());
    });

    it('writes no wiring entry and no dispatcher when the edited script was the only hook of its event', () => {
      const root = tempDir();
      seedSettings(root, EDITED_SETTINGS);
      const only = [hookAction('PreToolUse', 'Bash', 'guard-bash.mjs')];

      const { effects, settingsPlan } = computeEffects(root, only);

      expect(
        effects.some(
          (e) => e.action.dest === '.claude/scripts/hook-wiring.json',
        ),
      ).toBe(false);
      expect(JSON.parse(settingsPlan!.text!).hooks.PreToolUse).toEqual(
        EDITED_SETTINGS.hooks!.PreToolUse,
      );
    });
  });

  it('writes one PreToolUse entry whose matcher is the sorted union of its hooks’ alternatives', () => {
    const settings = plannedSettings(tempDir(), [
      hookAction('PreToolUse', 'Read|Bash', 'guard-read.mjs'),
      hookAction('PreToolUse', 'Bash', 'guard-bash.mjs'),
      hookAction('PreToolUse', 'mcp__(a|b)__x', 'guard-mcp.mjs'),
    ]);

    expect(settings.hooks).toEqual({
      PreToolUse: [
        {
          matcher: 'Bash|Read|mcp__(a|b)__x',
          hooks: [{ type: 'command', command: DISPATCH_GUARD }],
        },
      ],
    });
  });

  it('drops the matcher when any hook in the event has none', () => {
    const settings = plannedSettings(tempDir(), [
      hookAction('PostToolUse', 'Edit', 'regen-on-edit.mjs'),
      hookAction('PostToolUse', null, 'tool-output-trim.mjs'),
    ]);

    expect(settings.hooks?.PostToolUse).toEqual([
      {
        hooks: [
          {
            type: 'command',
            command: hookCommand('hook-dispatch.mjs', 'silent'),
          },
        ],
      },
    ]);
  });

  it('marks the dispatcher onFailure block when one of its hooks carries it', () => {
    const settings = plannedSettings(tempDir(), [
      hookAction('PreToolUse', 'Bash', 'guard-bash.mjs', {
        onFailure: 'block',
      }),
      hookAction('PreToolUse', 'Read', 'guard-read.mjs'),
    ]);

    expect(settings.hooks?.PreToolUse?.[0]?.hooks).toEqual([
      { type: 'command', command: DISPATCH_GUARD, onFailure: 'block' },
    ]);
  });

  it('gives the dispatcher a timeout past its slowest hook when that outlasts the harness default for the event', () => {
    const settings = plannedSettings(tempDir(), [
      hookAction('UserPromptSubmit', null, 'slow.mjs', { timeout: 60 }),
      hookAction('UserPromptSubmit', null, 'quick.mjs'),
    ]);

    expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.timeout).toBe(62);
  });

  it('leaves the dispatcher timeout unset when the harness default covers its slowest hook', () => {
    const settings = plannedSettings(tempDir(), [
      hookAction('Stop', null, 'lint-format-fix.mjs', { timeout: 120 }),
      hookAction('UserPromptSubmit', null, 'quick.mjs', { timeout: 20 }),
    ]);

    expect(settings.hooks?.Stop?.[0]?.hooks?.[0]).not.toHaveProperty('timeout');
    expect(
      settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0],
    ).not.toHaveProperty('timeout');
  });

  it('gives the SessionStart dispatcher the bootstrap fallback when payload-sync is among its hooks', () => {
    const settings = plannedSettings(tempDir(), [
      hookAction('SessionStart', null, 'session-context.mjs'),
      hookAction('SessionStart', null, 'payload-sync.mjs', {
        fallback: 'bootstrap',
      }),
    ]);

    expect(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toBe(
      hookCommand('hook-dispatch.mjs', 'bootstrap'),
    );
  });

  it('keeps a hook with an if condition as its own direct settings entry', () => {
    const settings = plannedSettings(tempDir(), [
      hookAction('PreToolUse', 'Bash', 'guard-bash.mjs'),
      hookAction('PreToolUse', 'Edit', 'conditional.mjs', {
        if: 'tool_input.file_path',
      }),
    ]);

    expect(settings.hooks?.PreToolUse).toEqual([
      {
        matcher: 'Edit',
        hooks: [
          {
            type: 'command',
            command: hookCommand('conditional.mjs', 'guard'),
            if: 'tool_input.file_path',
          },
        ],
      },
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: DISPATCH_GUARD }],
      },
    ]);
  });

  it('writes each dispatched hook to hook-wiring.json in plan order, without the direct one', () => {
    const wiring = plannedWiring([
      hookAction('PreToolUse', 'Bash', 'guard-bash.mjs', {
        onFailure: 'block',
      }),
      hookAction('Stop', null, 'lint-format-fix.mjs', { timeout: 120 }),
      hookAction('PreToolUse', 'Edit', 'conditional.mjs', { async: true }),
      hookAction('Stop', null, 'lint-format-fix.mjs'),
    ]);

    expect(wiring).toEqual({
      version: 1,
      events: {
        PreToolUse: [
          { script: 'guard-bash.mjs', matcher: 'Bash', onFailure: 'block' },
        ],
        Stop: [{ script: 'lint-format-fix.mjs', timeout: 120 }],
      },
    });
  });

  it('plans no wiring file when no hook is dispatchable', () => {
    const { effects } = computeEffects(tempDir(), [
      hookAction('Stop', null, 'conditional.mjs', { async: true }),
    ]);

    expect(effects.map((e) => e.action.dest)).toEqual([]);
  });

  it('drops a pre-dispatch per-script entry houserules wrote, keeping the user’s hook in the same group', () => {
    const root = tempDir();
    seedSettings(root, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              { type: 'command', command: 'node ./my-own-hook.js' },
              {
                type: 'command',
                command: hookCommand('guard-bash.mjs', 'guard'),
                onFailure: 'block',
              },
            ],
          },
        ],
      },
    });

    const settings = plannedSettings(root, [
      hookAction('PreToolUse', 'Bash', 'guard-bash.mjs', {
        onFailure: 'block',
      }),
    ]);

    expect(settings.hooks?.PreToolUse).toEqual([
      {
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: 'node ./my-own-hook.js' },
          { type: 'command', command: DISPATCH_GUARD, onFailure: 'block' },
        ],
      },
    ]);
  });

  it('keeps a user’s edited variant of a dispatched script’s command', () => {
    const root = tempDir();
    const variant = 'node .claude/scripts/guard-bash.mjs --verbose';
    seedSettings(root, {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: variant }] },
        ],
      },
    });

    const settings = plannedSettings(root, [
      hookAction('PreToolUse', 'Bash', 'guard-bash.mjs'),
    ]);

    expect(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command).toBe(variant);
  });

  it('moves an existing dispatcher entry onto the matcher a newly added hook needs', () => {
    const root = tempDir();
    seedSettings(root, {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: DISPATCH_GUARD }],
          },
        ],
      },
    });

    const settings = plannedSettings(root, [
      hookAction('PreToolUse', 'Bash', 'guard-bash.mjs'),
      hookAction('PreToolUse', 'Read', 'guard-read.mjs'),
    ]);

    expect(settings.hooks?.PreToolUse).toEqual([
      {
        matcher: 'Bash|Read',
        hooks: [{ type: 'command', command: DISPATCH_GUARD }],
      },
    ]);
  });

  it('records the dispatcher, not the dispatched script, in the settings signature', () => {
    const { signature } = computeEffects(tempDir(), [
      hookAction('PreToolUse', 'Bash', 'guard-bash.mjs'),
    ]);

    expect(signature.hooks).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', script: 'hook-dispatch.mjs' },
    ]);
  });
});

describe('computeEffects, given a file whose on-disk hash differs from the manifest', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-generated-'));
    dirs.push(dir);
    return dir;
  }

  function writeAction(dest: string, content: string): WriteAction {
    return { kind: 'write', module: 'core', dest, content, reason: 'test' };
  }

  const SELF_GITIGNORE = writeAction('.claude/scripts/.gitignore', '*\n');

  function opForOlderCopyUnderNewerManifest(
    dest: string,
    actions: WriteAction[],
  ): Effect['op'] {
    const root = tempDir();
    mkdirSync(dirname(join(root, dest)), { recursive: true });
    writeFileSync(join(root, dest), 'older generated copy\n');
    const manifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['core'],
      files: { [dest]: sha256('copy the newer manifest recorded\n') },
    };
    const { effects } = computeEffects(
      root,
      [...actions, writeAction(dest, 'canonical today\n')],
      { manifest },
    );
    return effects.find((e) => e.action.dest === dest)!.op;
  }

  it('refreshes a mismatched file under a self-gitignored .claude/scripts/ without --force', () => {
    expect(
      opForOlderCopyUnderNewerManifest('.claude/scripts/guard.mjs', [
        SELF_GITIGNORE,
      ]),
    ).toBe('update');
  });

  it('keeps the same mismatch outside the self-gitignored directories as a local edit', () => {
    expect(
      opForOlderCopyUnderNewerManifest('.claude/agents/guard.md', [
        SELF_GITIGNORE,
      ]),
    ).toBe('skip-modified');
  });

  it('keeps a mismatch on a dest the .claude/.gitignore block lists as a local edit', () => {
    const dest = '.claude/rules/guard.md';
    const block = single(
      payloadGitignoreActions(makeCtx(), [
        SELF_GITIGNORE,
        writeAction(dest, 'canonical today\n'),
      ]),
    ) as RegionAction;
    expect(block.body.split('\n')).toContain('/rules/guard.md');

    expect(opForOlderCopyUnderNewerManifest(dest, [SELF_GITIGNORE])).toBe(
      'skip-modified',
    );
  });

  it('keeps a mismatched script as a local edit when the plan does not self-gitignore .claude/scripts/', () => {
    expect(
      opForOlderCopyUnderNewerManifest('.claude/scripts/guard.mjs', []),
    ).toBe('skip-modified');
  });
});

describe('computePrune, given a manifest entry whose file is already absent', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-prune-gone-'));
    dirs.push(dir);
    return dir;
  }

  it('records it as gone rather than as deleted', () => {
    const root = tempDir();
    const manifest = {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: [],
      files: { 'rules/vanished.md': sha256('gone\n') },
    };

    const { deletes } = computePrune(root, {
      manifest,
      plannedDests: new Set(),
    });

    expect(deletes).toEqual([{ dest: 'rules/vanished.md', gone: true }]);
  });
});

describe('computePrune, given a manifest destination that is a symlink', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-prune-link-'));
    dirs.push(dir);
    return dir;
  }

  function manifestOf(files: Record<string, string>) {
    return {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: [],
      files,
    };
  }

  it('prunes a dangling link as a real delete, never as gone', () => {
    const root = tempDir();
    mkdirSync(join(root, 'rules'));
    symlinkSync(join(root, 'missing-target.md'), join(root, 'rules/link.md'));

    const { deletes, kept } = computePrune(root, {
      manifest: manifestOf({ 'rules/link.md': sha256('x\n') }),
      plannedDests: new Set(),
    });

    expect(deletes).toEqual([{ dest: 'rules/link.md', modified: false }]);
    expect(kept).toEqual([]);
  });

  it('hashes a link to a file through the link', () => {
    const root = tempDir();
    mkdirSync(join(root, 'rules'));
    writeFileSync(join(root, 'real.md'), 'x\n');
    symlinkSync(join(root, 'real.md'), join(root, 'rules/link.md'));

    const { deletes } = computePrune(root, {
      manifest: manifestOf({ 'rules/link.md': sha256('x\n') }),
      plannedDests: new Set(),
    });

    expect(deletes).toEqual([{ dest: 'rules/link.md', modified: false }]);
  });

  it('keeps a link to a directory unless forced, and never reads it', () => {
    const root = tempDir();
    mkdirSync(join(root, 'rules'));
    mkdirSync(join(root, 'realdir'));
    symlinkSync(join(root, 'realdir'), join(root, 'rules/link'));
    const manifest = manifestOf({ 'rules/link': sha256('x\n') });

    const unforced = computePrune(root, { manifest, plannedDests: new Set() });
    expect(unforced.kept).toEqual(['rules/link']);
    expect(unforced.deletes).toEqual([]);

    const forced = computePrune(root, {
      manifest,
      plannedDests: new Set(),
      force: true,
    });
    expect(forced.deletes).toEqual([{ dest: 'rules/link', modified: true }]);
  });

  it('never prunes a dangling link at a shared host file', () => {
    const root = tempDir();
    const dest = [...SHARED_HOST_FILES][0]!;
    mkdirSync(dirname(join(root, dest)), { recursive: true });
    symlinkSync(join(root, 'missing.md'), join(root, dest));

    const { deletes, kept } = computePrune(root, {
      manifest: manifestOf({ [dest]: sha256('x\n') }),
      plannedDests: new Set(),
      force: true,
    });

    expect(deletes).toEqual([]);
    expect(kept).toEqual([]);
  });
});

describe('computeEffects, given an ejected dest', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-ejected-'));
    dirs.push(dir);
    return dir;
  }

  function writeFile(root: string, rel: string, content: string): string {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  }

  const DEST = '.claude/skills/tidy/SKILL.md';
  const CANONICAL = 'canonical skill\n';
  const EDITED = 'my edited skill\n';

  function writeAction(dest: string): WriteAction {
    return {
      kind: 'write',
      module: 'core',
      dest,
      content: CANONICAL,
      reason: 'test',
    };
  }

  function manifestWith(files: Record<string, string>) {
    return {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['core'],
      files,
    };
  }

  it('keeps an edit with no recorded hash, judging it against the canonical hash', () => {
    const root = tempDir();
    writeFile(root, DEST, EDITED);

    const effect = single(
      computeEffects(root, [writeAction(DEST)], { ejected: new Set([DEST]) })
        .effects,
    );

    expect(effect.op).toBe('skip-modified');
    expect(effect.substitutedHash).toBe(sha256(CANONICAL));
  });

  it('refreshes the same edit with no recorded hash when the dest is not ejected', () => {
    const root = tempDir();
    writeFile(root, DEST, EDITED);

    const effect = single(computeEffects(root, [writeAction(DEST)]).effects);

    expect(effect.op).toBe('update');
    expect(effect.substitutedHash).toBeUndefined();
  });

  it('substitutes nothing when the manifest records the dest', () => {
    const root = tempDir();
    writeFile(root, DEST, EDITED);

    const effect = single(
      computeEffects(root, [writeAction(DEST)], {
        manifest: manifestWith({ [DEST]: sha256('an older canonical\n') }),
        ejected: new Set([DEST]),
      }).effects,
    );

    expect(effect.op).toBe('skip-modified');
    expect(effect.substitutedHash).toBeUndefined();
  });

  it('keeps an edit under force, which never writes an ejected file', () => {
    const root = tempDir();
    writeFile(root, DEST, EDITED);

    const effect = single(
      computeEffects(root, [writeAction(DEST)], {
        manifest: manifestWith({ [DEST]: sha256('an older canonical\n') }),
        force: true,
        ejected: new Set([DEST]),
      }).effects,
    );

    expect(effect.op).toBe('skip-modified');
  });

  it('keeps an edited body with no recorded hash, judging it against the canonical body', () => {
    const payloadDir = tempDir();
    const root = tempDir();
    const dest = '.claude/rules/example.md';
    const frontmatter = '---\npaths:\n  - "*.ts"\n---\n';
    const src = writeFile(
      payloadDir,
      'example.md',
      `${frontmatter}Shipped body.\n`,
    );
    writeFile(root, dest, `${frontmatter}My body.\n`);
    const action: BodyAction = {
      kind: 'body',
      module: 'test',
      src,
      dest,
      reason: 'test',
    };

    const effect = single(
      computeEffects(root, [action], { ejected: new Set([dest]) }).effects,
    );

    expect(effect.op).toBe('skip-modified');
    expect(effect.substitutedHash).toBe(sha256('Shipped body.\n'));
  });
});

describe('computePrune, given an ejected dest no current module plans', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-prune-ejected-'));
    dirs.push(dir);
    return dir;
  }

  const DEST = '.claude/skills/tidy/SKILL.md';
  const CONTENT = 'unedited skill\n';

  function rootWithDest(): string {
    const root = tempDir();
    mkdirSync(dirname(join(root, DEST)), { recursive: true });
    writeFileSync(join(root, DEST), CONTENT);
    return root;
  }

  it('keeps an unedited one the manifest records, even under force', () => {
    const root = rootWithDest();

    const prune = computePrune(root, {
      manifest: {
        kitVersion: '1.0.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        modules: [],
        files: { [DEST]: sha256(CONTENT) },
      },
      plannedDests: new Set(),
      force: true,
      ejected: new Set([DEST]),
    });

    expect(prune.deletes).toEqual([]);
    expect(prune.kept).toEqual([]);
    expect(prune.ejected).toEqual([DEST]);
  });

  it('finds one with no manifest from the ejected list alone', () => {
    const root = rootWithDest();

    const prune = computePrune(root, {
      manifest: null,
      plannedDests: new Set(),
      ejected: new Set([DEST]),
    });

    expect(prune.ejected).toEqual([DEST]);
  });

  it('lists nothing for an ejected dest a current module still plans', () => {
    const root = rootWithDest();

    const prune = computePrune(root, {
      manifest: null,
      plannedDests: new Set([DEST]),
      ejected: new Set([DEST]),
    });

    expect(prune.ejected).toEqual([]);
  });

  it('lists nothing for an ejected dest absent from disk', () => {
    const root = tempDir();

    const prune = computePrune(root, {
      manifest: null,
      plannedDests: new Set(),
      ejected: new Set([DEST]),
    });

    expect(prune.ejected).toEqual([]);
  });
});

describe('computeEffects, given a rule whose paths the config sets', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kit-plan-rule-paths-'));
    dirs.push(dir);
    return dir;
  }

  function writeFile(root: string, rel: string, content: string): string {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  }

  const DEST = '.claude/rules/example.md';
  const SHIPPED_FRONTMATTER =
    "---\ndescription:  kept  as is\npaths:\n  - '**/*.ts'\n  - '**/*.svelte'\nalwaysApply: false\n---\n";
  const RENDERED_FRONTMATTER =
    "---\ndescription:  kept  as is\npaths:\n  - 'src/**/*.ts'\nalwaysApply: false\n---\n";
  const SHIPPED_BODY = '\n# Example\n\nCurrent body.\n';
  const RULE_PATHS = { example: ['src/**/*.ts'] };

  function bodyAction(src: string, dest = DEST): BodyAction {
    return { kind: 'body', module: 'test', src, dest, reason: 'test' };
  }

  function manifestWith(body: string, frontmatter: string) {
    return {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['test'],
      files: {
        [DEST]: { body: sha256(body), frontmatter: sha256(frontmatter) },
      },
    };
  }

  it('creates the rule with the config paths rendered and every other key byte for byte', () => {
    const src = writeFile(
      tempDir(),
      'example.md',
      SHIPPED_FRONTMATTER + SHIPPED_BODY,
    );

    const effect = single(
      computeEffects(tempDir(), [bodyAction(src)], { rulePaths: RULE_PATHS })
        .effects,
    );

    expect(effect.op).toBe('create');
    expect(effect.content?.toString('utf8')).toBe(
      RENDERED_FRONTMATTER + SHIPPED_BODY,
    );
  });

  it("records the shipped frontmatter's hash and the body's, never the rendered frontmatter's", () => {
    const src = writeFile(
      tempDir(),
      'example.md',
      SHIPPED_FRONTMATTER + SHIPPED_BODY,
    );

    const effect = single(
      computeEffects(tempDir(), [bodyAction(src)], { rulePaths: RULE_PATHS })
        .effects,
    );

    expect(effect.frontmatterHash).toBe(sha256(SHIPPED_FRONTMATTER));
    expect(effect.hash).toBe(sha256(SHIPPED_BODY));
  });

  it('renders the config paths over the shipped frontmatter on a refresh, along with the new body', () => {
    const root = tempDir();
    const src = writeFile(
      tempDir(),
      'example.md',
      SHIPPED_FRONTMATTER + SHIPPED_BODY,
    );
    writeFile(root, DEST, SHIPPED_FRONTMATTER + 'Old body.\n');

    const effect = single(
      computeEffects(root, [bodyAction(src)], {
        rulePaths: RULE_PATHS,
        manifest: manifestWith('Old body.\n', SHIPPED_FRONTMATTER),
      }).effects,
    );

    expect(effect.op).toBe('update');
    expect(effect.content?.toString('utf8')).toBe(
      RENDERED_FRONTMATTER + SHIPPED_BODY,
    );
  });

  it('skips as identical once the rendered rule is on disk', () => {
    const root = tempDir();
    const src = writeFile(
      tempDir(),
      'example.md',
      SHIPPED_FRONTMATTER + SHIPPED_BODY,
    );
    writeFile(root, DEST, RENDERED_FRONTMATTER + SHIPPED_BODY);

    const effect = single(
      computeEffects(root, [bodyAction(src)], {
        rulePaths: RULE_PATHS,
        manifest: manifestWith(SHIPPED_BODY, SHIPPED_FRONTMATTER),
      }).effects,
    );

    expect(effect.op).toBe('skip-identical');
  });

  it('replaces a hand-trimmed frontmatter with the rendered one, since the config owns it', () => {
    const root = tempDir();
    const src = writeFile(
      tempDir(),
      'example.md',
      SHIPPED_FRONTMATTER + SHIPPED_BODY,
    );
    writeFile(root, DEST, "---\npaths:\n  - 'lib/**'\n---\n" + SHIPPED_BODY);

    const effect = single(
      computeEffects(root, [bodyAction(src)], {
        rulePaths: RULE_PATHS,
        manifest: manifestWith(SHIPPED_BODY, SHIPPED_FRONTMATTER),
      }).effects,
    );

    expect(effect.op).toBe('update');
    expect(effect.content?.toString('utf8')).toBe(
      RENDERED_FRONTMATTER + SHIPPED_BODY,
    );
  });

  it('adds the key to a rule that ships no paths', () => {
    const src = writeFile(
      tempDir(),
      'example.md',
      '---\ndescription: no globs\n---\n' + SHIPPED_BODY,
    );

    const effect = single(
      computeEffects(tempDir(), [bodyAction(src)], { rulePaths: RULE_PATHS })
        .effects,
    );

    expect(effect.content?.toString('utf8')).toBe(
      "---\ndescription: no globs\npaths:\n  - 'src/**/*.ts'\n---\n" +
        SHIPPED_BODY,
    );
  });

  it('keeps a hand-trimmed frontmatter when the config sets paths only for another rule', () => {
    const root = tempDir();
    const src = writeFile(
      tempDir(),
      'example.md',
      SHIPPED_FRONTMATTER + SHIPPED_BODY,
    );
    const trimmed = "---\npaths:\n  - 'lib/**'\n---\n";
    writeFile(root, DEST, trimmed + 'Old body.\n');

    const effect = single(
      computeEffects(root, [bodyAction(src)], {
        rulePaths: { other: ['src/**'] },
        manifest: manifestWith('Old body.\n', SHIPPED_FRONTMATTER),
      }).effects,
    );

    expect(effect.op).toBe('update');
    expect(effect.content?.toString('utf8')).toBe(trimmed + SHIPPED_BODY);
  });

  it('leaves a body action outside .claude/rules/ alone, whatever its file name', () => {
    const src = writeFile(
      tempDir(),
      'example.md',
      SHIPPED_FRONTMATTER + SHIPPED_BODY,
    );

    const effect = single(
      computeEffects(tempDir(), [bodyAction(src, '.claude/other/example.md')], {
        rulePaths: RULE_PATHS,
      }).effects,
    );

    expect(effect.content?.toString('utf8')).toBe(
      SHIPPED_FRONTMATTER + SHIPPED_BODY,
    );
  });
});
