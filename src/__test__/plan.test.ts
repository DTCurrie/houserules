import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  KitError,
  MODULES,
  SHARED_HOST_FILES,
  classifyWrite,
  computeEffects,
  computePrune,
  defaultModuleIds,
  resolveModuleIds,
} from '../plan.js';
import type { BodyAction } from '../actions.js';
import { makeCtx, makeTarget } from '#test/ctx-builder';
import { sha256 } from '#test/installed-tree';

describe('resolveModuleIds', () => {
  it('returns the defaults when no flag is given', () => {
    const ctx = makeCtx();
    expect(resolveModuleIds(ctx)).toEqual(defaultModuleIds(ctx));
  });

  it('returns the defaults for an empty string flag', () => {
    const ctx = makeCtx();
    expect(resolveModuleIds(ctx, '')).toEqual(defaultModuleIds(ctx));
  });

  it('adds a bare module id to the defaults', () => {
    const ctx = makeCtx();
    expect(resolveModuleIds(ctx, 'ledger')).toContain('ledger');
  });

  it('removes a default module with a "-" prefix', () => {
    const ctx = makeCtx({ typescript: true });
    expect(defaultModuleIds(ctx)).toContain('rename');
    expect(resolveModuleIds(ctx, '-rename')).not.toContain('rename');
  });

  it('re-adds "core" even when "-core" is given, since core is always forced on', () => {
    const ctx = makeCtx();
    expect(resolveModuleIds(ctx, '-core')).toContain('core');
  });

  it('adds a bare module id to the defaults rather than replacing them', () => {
    const ctx = makeCtx();
    const resolved = resolveModuleIds(ctx, 'ledger');

    expect(resolved).toEqual(
      expect.arrayContaining([...defaultModuleIds(ctx), 'ledger']),
    );
  });

  it('applies several comma-separated entries, mixing additions and removals', () => {
    const ctx = makeCtx({ typescript: true });
    const resolved = resolveModuleIds(ctx, 'ledger,-rename');
    expect(resolved).toContain('ledger');
    expect(resolved).not.toContain('rename');
  });

  it('trims whitespace around comma-separated entries', () => {
    const ctx = makeCtx();
    expect(resolveModuleIds(ctx, ' ledger , backlog ')).toEqual(
      expect.arrayContaining(['ledger', 'backlog']),
    );
  });

  it('ignores an empty entry produced by a trailing or doubled comma', () => {
    const ctx = makeCtx();
    expect(resolveModuleIds(ctx, 'ledger,,')).toEqual(
      resolveModuleIds(ctx, 'ledger'),
    );
  });

  it('returns ids in MODULES registry order regardless of flag order', () => {
    const ctx = makeCtx();
    const resolved = resolveModuleIds(ctx, 'testing,backlog');
    const registryOrder = MODULES.map((m) => m.id).filter((id) =>
      resolved.includes(id),
    );
    expect(resolved).toEqual(registryOrder);
  });

  it('throws a KitError naming the offending id for an unknown module', () => {
    const ctx = makeCtx();
    expect(() => resolveModuleIds(ctx, 'nope')).toThrow(KitError);
    expect(() => resolveModuleIds(ctx, 'nope')).toThrow(
      /Unknown module "nope"/,
    );
  });

  it('lists the known module ids in the unknown-module error message', () => {
    const ctx = makeCtx();
    try {
      resolveModuleIds(ctx, 'nope');
      throw new Error('expected resolveModuleIds to throw');
    } catch (e) {
      expect((e as Error).message).toContain('core');
    }
  });

  it('throws on an unknown id even when it carries a "-" prefix', () => {
    const ctx = makeCtx();
    expect(() => resolveModuleIds(ctx, '-nope')).toThrow(
      /Unknown module "nope"/,
    );
  });
});

describe('defaultModuleIds', () => {
  it('includes "rename" only when TypeScript is detected', () => {
    expect(defaultModuleIds(makeCtx({ typescript: false }))).not.toContain(
      'rename',
    );
    expect(defaultModuleIds(makeCtx({ typescript: true }))).toContain('rename');
  });

  it('includes "changesets" when a .changeset config already exists', () => {
    const ctx = makeCtx({
      changesets: {
        configExists: true,
        config: null,
        pendingCount: 0,
        devDep: false,
        rootScript: null,
        invocation: 'devdep',
        baseBranch: 'main',
      },
    });
    expect(defaultModuleIds(ctx)).toContain('changesets');
  });

  it('includes "changesets" for a monorepo even without an existing config', () => {
    const ctx = makeCtx({ isMonorepo: true });
    expect(defaultModuleIds(ctx)).toContain('changesets');
  });

  it('excludes "changesets" for a single-package repo with no existing config', () => {
    const ctx = makeCtx({ isMonorepo: false });
    expect(defaultModuleIds(ctx)).not.toContain('changesets');
  });

  it('includes "lint-fix" only when a target declares fix commands', () => {
    const noFix = makeCtx({ targets: [makeTarget({ fixCommands: null })] });
    const withFix = makeCtx({
      targets: [makeTarget({ fixCommands: ['eslint --fix'] })],
    });
    expect(defaultModuleIds(noFix)).not.toContain('lint-fix');
    expect(defaultModuleIds(withFix)).toContain('lint-fix');
  });

  it('always includes "core"', () => {
    expect(defaultModuleIds(makeCtx())).toContain('core');
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
