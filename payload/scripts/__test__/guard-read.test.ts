import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import {
  editKitConfig,
  hookCommandsFor,
  settingsOf,
} from '#test/installed-tree';
import { readToolInput } from '#test/hook-input';

describe('guard-read.mjs', () => {
  const GUARD = '.claude/scripts/guard-read.mjs';
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo', { modules: 'read-guard' });
  });

  it('installs the guard script and wires it into a PreToolUse(Read) hook', () => {
    expect(existsSync(join(root, GUARD))).toBeTruthy();
    const settings = settingsOf(root);
    expect(
      hookCommandsFor(settings, 'PreToolUse').some((c) =>
        c.includes('guard-read.mjs'),
      ),
    ).toBeTruthy();
  });

  it('blocks an unbounded read of a denylisted lockfile', () => {
    const r = runScript(
      root,
      GUARD,
      readToolInput({ file_path: 'pnpm-lock.yaml' }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/read guard/);
  });

  it('allows a bounded read of the same denylisted file, since an offset/limit read is targeted', () => {
    const r = runScript(
      root,
      GUARD,
      readToolInput({ file_path: 'pnpm-lock.yaml', limit: 40 }),
    );
    expect(r.status, r.stderr).toBe(0);
  });

  it('allows an unbounded read of a normal small source file', () => {
    const r = runScript(
      root,
      GUARD,
      readToolInput({ file_path: 'apps/studio/src/main.ts' }),
    );
    expect(r.status, r.stderr).toBe(0);
  });

  it('blocks a whole-file read once the file exceeds the configured maxBytes', () => {
    editKitConfig(root, (c) => {
      c.readGuard = { maxBytes: 5 };
    });
    const r = runScript(
      root,
      GUARD,
      readToolInput({ file_path: 'apps/studio/src/main.ts' }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/large/);
  });
});
