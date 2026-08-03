import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeCtx } from '#test/ctx-builder';
import { useRepo } from '#test/repo';
import type { KitManifest } from '../../../core/manifest.js';
import type { Ctx } from '../../../detect.js';
import { checkModuleHealth } from '../module-health.js';

function ctxWith(modules: string[], overrides: Partial<Ctx> = {}): Ctx {
  const manifest: KitManifest = {
    kitVersion: '1.0.0',
    installedAt: '2026-01-01T00:00:00.000Z',
    modules,
    files: {},
  };
  const base = makeCtx(overrides);
  return { ...base, claude: { ...base.claude, manifest } };
}

describe('checkModuleHealth, per-module prerequisites', () => {
  it('warns when rename is installed in a repo with no typescript dependency', () => {
    const ctx = ctxWith(['rename'], { typescript: false });

    expect(checkModuleHealth('/repo', ctx).findings).toContainEqual(
      expect.objectContaining({
        msg: expect.stringContaining('rename.mjs will fail'),
      }),
    );
  });

  it('stays quiet about rename when typescript is present', () => {
    const ctx = ctxWith(['rename'], { typescript: true });

    expect(checkModuleHealth('/repo', ctx).findings).toEqual([]);
  });

  it('warns with a ready-to-paste verify block when verify-changed has none', () => {
    const ctx = ctxWith(['verify-changed']);
    ctx.claude.kitConfig = { version: 2 } as Ctx['claude']['kitConfig'];

    expect(checkModuleHealth('/repo', ctx).findings).toContainEqual(
      expect.objectContaining({
        msg: expect.stringContaining('"verify": {'),
      }),
    );
  });

  it('warns that a seeded reviewer agent is still a DRAFT', () => {
    const root = useRepo('pnpm-single');
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'agents', 'core-reviewer.md'),
      '---\ndescription: DRAFT — fill this in\n---\n',
    );
    const ctx = ctxWith(['reviewers']);
    ctx.claude.agents = ['core-reviewer.md'];

    expect(checkModuleHealth(root, ctx).findings).toContainEqual(
      expect.objectContaining({
        msg: 'agent core-reviewer.md is still a DRAFT — fill in its authoritative source',
      }),
    );
  });

  it('stays quiet about an agent whose description is filled in', () => {
    const root = useRepo('pnpm-single');
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'agents', 'core-reviewer.md'),
      '---\ndescription: Reviews src/ against the design docs\n---\n',
    );
    const ctx = ctxWith(['reviewers']);
    ctx.claude.agents = ['core-reviewer.md'];

    expect(checkModuleHealth(root, ctx).findings).toEqual([]);
  });
});
