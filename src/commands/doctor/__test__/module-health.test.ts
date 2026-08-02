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

function writeOutputStyle(root: string, style: string): void {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude', 'settings.local.json'),
    JSON.stringify({ outputStyle: style }),
  );
}

describe('checkModuleHealth, terse-style activation', () => {
  it('reports ACTIVE when settings.local.json selects the frontmatter name', () => {
    const root = useRepo('pnpm-single');
    writeOutputStyle(root, 'Kit Terse');

    expect(checkModuleHealth(root, ctxWith(['terse-style'])).readouts).toEqual([
      'terse-style: ACTIVE (outputStyle "Kit Terse")',
    ]);
  });

  it('warns when the filename slug is selected, since it silently falls back to Default', () => {
    const root = useRepo('pnpm-single');
    writeOutputStyle(root, 'kit-terse');

    expect(
      checkModuleHealth(root, ctxWith(['terse-style'])).findings,
    ).toContainEqual(
      expect.objectContaining({
        level: 'WARN',
        msg: expect.stringContaining('is the filename slug'),
      }),
    );
  });

  it('reports INACTIVE naming the style that won when another one is selected', () => {
    const root = useRepo('pnpm-single');
    writeOutputStyle(root, 'Explanatory');

    expect(checkModuleHealth(root, ctxWith(['terse-style'])).readouts).toEqual([
      'terse-style: INACTIVE — installed, but outputStyle "Explanatory" is active instead',
    ]);
  });

  it('reports INACTIVE with activation instructions when no style is selected anywhere', () => {
    const root = useRepo('pnpm-single');

    expect(checkModuleHealth(root, ctxWith(['terse-style'])).readouts).toEqual([
      'terse-style: INACTIVE — installed but no outputStyle set; activate via /config → Output style → "Kit Terse", or set "outputStyle": "Kit Terse"',
    ]);
  });

  it('prefers settings.local.json over settings.json, since the local file wins at runtime', () => {
    const root = useRepo('pnpm-single');
    writeOutputStyle(root, 'Kit Terse');
    const ctx = ctxWith(['terse-style']);
    ctx.claude.settings = { outputStyle: 'Explanatory' };

    expect(checkModuleHealth(root, ctx).readouts).toEqual([
      'terse-style: ACTIVE (outputStyle "Kit Terse")',
    ]);
  });

  it('falls back to settings.json when settings.local.json names no style', () => {
    const root = useRepo('pnpm-single');
    const ctx = ctxWith(['terse-style']);
    ctx.claude.settings = { outputStyle: 'Kit Terse' };

    expect(checkModuleHealth(root, ctx).readouts).toEqual([
      'terse-style: ACTIVE (outputStyle "Kit Terse")',
    ]);
  });

  it('says nothing about output styles when the module is not installed', () => {
    const root = useRepo('pnpm-single');
    writeOutputStyle(root, 'kit-terse');

    expect(checkModuleHealth(root, ctxWith(['core']))).toEqual({
      findings: [],
      readouts: [],
    });
  });
});

describe('checkModuleHealth, per-module prerequisites', () => {
  it('errors when changesets is installed without a .changeset/config.json', () => {
    const ctx = ctxWith(['changesets']);

    expect(checkModuleHealth('/repo', ctx).findings).toContainEqual(
      expect.objectContaining({
        level: 'ERROR',
        msg: 'changesets module installed but .changeset/config.json is missing',
      }),
    );
  });

  it('warns when the changesets CLI resolves only through an external runner', () => {
    const base = ctxWith(['changesets']);
    const ctx = {
      ...base,
      changesets: {
        ...base.changesets,
        configExists: true,
        invocation: 'external-cli' as const,
      },
    };

    expect(checkModuleHealth('/repo', ctx).findings).toContainEqual(
      expect.objectContaining({
        level: 'WARN',
        msg: expect.stringContaining('changesets CLI not installed'),
      }),
    );
  });

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
