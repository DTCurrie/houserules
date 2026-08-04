import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  KitError,
  MODULES,
  SHARED_HOST_FILES,
  buildPlan,
  classifyWrite,
  computeEffects,
  computePrune,
  defaultModuleIds,
  resolveModuleIds,
} from '../plan.js';
import type { BodyAction } from '../actions.js';
import type { ModuleDef } from '../module-def.js';
import type { Registry, RegisteredModule } from '../plugin-registry.js';
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

  it('throws a KitError naming the offending id for an unknown module', () => {
    const ctx = makeCtx();
    expect(() => resolveModuleIds(ctx, registry, 'nope')).toThrow(KitError);
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
  it('selects the plugin module by its namespaced id and skips built-ins not requested', () => {
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
});

describe('SHARED_HOST_FILES', () => {
  it('contains exactly the four user-owned, region-managed paths', () => {
    expect(SHARED_HOST_FILES).toEqual(
      new Set([
        '.claude/settings.json',
        'CLAUDE.md',
        '.gitignore',
        '.prettierignore',
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

  it('refreshes a file only the kit has written, since a hash match means you never touched it', () => {
    const onDisk = Buffer.from('old kit content', 'utf8');
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

  it('skips a file you edited, since its bytes no longer match the hash the kit recorded', () => {
    const onDisk = Buffer.from('your local edit', 'utf8');
    expect(
      classifyWrite({
        exists: true,
        onDisk,
        canonical,
        recordedHash: sha256(Buffer.from('what the kit originally wrote')),
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
        recordedHash: sha256(Buffer.from('what the kit originally wrote')),
        force: true,
      }),
    ).toBe('update');
  });

  it('updates an unmanaged file the kit never wrote, since there is nothing recorded to have diverged from', () => {
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

  it('refreshes an empty on-disk file that only the kit wrote, matching the recorded hash of empty content', () => {
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

    expect(effects).toHaveLength(1);
    expect(effects[0].op).toBe('create');
    expect(effects[0].content?.toString('utf8')).toBe(SHIPPED);
    expect(effects[0].hash).toBe(sha256(SHIPPED_BODY));
    expect(effects[0].frontmatterHash).toBe(sha256(SHIPPED_FRONTMATTER));
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

    expect(effects[0].op).toBe('skip-identical');
    expect(effects[0].content?.toString('utf8')).toBe(
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

    expect(effects[0].op).toBe('update');
    expect(effects[0].content?.toString('utf8')).toBe(
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

    expect(effects[0].op).toBe('skip-modified');
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

    expect(effects[0].op).toBe('update');
    expect(effects[0].content?.toString('utf8')).toBe(
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

    expect(effects[0].op).toBe('update');
    expect(effects[0].content?.toString('utf8')).toBe(
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

    expect(effects[0].op).toBe('skip-modified');
  });

  it('silently replaces an untouched frontmatter with the shipped default when the kit moved it on', () => {
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

    expect(effects[0].op).toBe('update');
    expect(effects[0].content?.toString('utf8')).toBe(
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

    expect(effects[0].content?.toString('utf8')).toBe(
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

    expect(effects[0].op).toBe('update');
    expect(effects[0].content?.toString('utf8')).toBe(
      newShippedFrontmatter + SHIPPED_BODY,
    );
  });

  it('throws a KitError naming the payload path when the src is missing', () => {
    const root = tempDir();
    const action = bodyAction(join(tempDir(), 'nonexistent.md'));

    expect(() => computeEffects(root, [action])).toThrow(KitError);
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
    start: '<!-- agent-kit:claude-md start -->',
    end: '<!-- agent-kit:claude-md end -->',
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

    expect(effects[0].op).toBe('update');
  });

  it('still refuses a body the user edited', () => {
    const root = tempDir();
    hostFile(root, CURRENT, 'body the user rewrote');

    const { effects } = computeEffects(root, [regionAction('new body')], {
      manifest: manifestRecording(sha256('what the kit last wrote')),
    });

    expect(effects[0].op).toBe('skip-modified');
  });

  it('adopts a block under legacy markers even though no recorded hash can match it', () => {
    const root = tempDir();
    hostFile(
      root,
      CURRENT.legacy,
      'body written by the previous kit generation',
    );

    const { effects } = computeEffects(root, [regionAction('new body')], {
      manifest: manifestRecording('a-hash-from-another-codebase'),
    });

    expect(effects[0].op).toBe('update');
  });

  it('leaves no legacy marker behind once it adopts', () => {
    const root = tempDir();
    hostFile(root, CURRENT.legacy, 'old');

    const { effects } = computeEffects(root, [regionAction('new body')], {
      manifest: manifestRecording('a-hash-from-another-codebase'),
    });

    expect(effects[0].content!.toString()).not.toContain(
      'claude-kit:claude-md',
    );
  });

  it('preserves every byte outside the markers when adopting', () => {
    const root = tempDir();
    hostFile(root, CURRENT.legacy, 'old');

    const { effects } = computeEffects(root, [regionAction('new body')], {
      manifest: manifestRecording('a-hash-from-another-codebase'),
    });

    const written = effects[0].content!.toString();
    expect(written.startsWith('# Title\n')).toBe(true);
    expect(written.endsWith('\nUser prose below.\n')).toBe(true);
  });
});
