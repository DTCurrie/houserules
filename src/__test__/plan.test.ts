import { describe, expect, it } from 'vitest';

import {
  KitError,
  MODULES,
  SHARED_HOST_FILES,
  classifyWrite,
  defaultModuleIds,
  resolveModuleIds,
} from '../plan.js';
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
    for (const defaultId of defaultModuleIds(ctx)) {
      expect(resolved).toContain(defaultId);
    }
    expect(resolved).toContain('ledger');
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
