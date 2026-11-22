import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { HouseConfig } from '@houserules/api';
import { MANIFEST_PATH } from '@houserules/api/internal';
import type { HouseManifest } from '@houserules/api/internal';
import { makeCtx } from '#test/ctx-builder';
import {
  noTerminalReport,
  preverifyMigration,
} from '../migration-preverify.js';
import type { MigrationClassification } from '../migration-classify.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'preverify-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  put(root, files);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function put(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function classification(
  classified: string[],
  edited: string[] = [],
): MigrationClassification {
  return { classified, edited, toEject: edited, rulePaths: {} };
}

function ctxFor(
  root: string,
  manifest: Partial<HouseManifest> | null,
  config: Partial<HouseConfig> | null = null,
) {
  const ctx = makeCtx({ root });
  ctx.claude.manifest = manifest
    ? ({
        kitVersion: '1',
        installedAt: 'x',
        modules: [],
        files: {},
        ...manifest,
      } as HouseManifest)
    : null;
  ctx.claude.houseConfig = config as HouseConfig | null;
  return ctx;
}

const FILES = {
  '.claude/rules/a.md': 'a\n',
  '.claude/rules/b.md': 'b\n',
  [MANIFEST_PATH]: '{}\n',
};
const CLASSIFIED = ['.claude/rules/a.md', '.claude/rules/b.md'];

function kinds(
  root: string,
  ctx: ReturnType<typeof ctxFor>,
  c: MigrationClassification,
) {
  return preverifyMigration(root, ctx, c).map((finding) => finding.kind);
}

describe('preverifyMigration, mass misread', () => {
  const none = () => {
    const root = repoWith(FILES);
    return { root, ctx: ctxFor(root, null) };
  };

  it('raises when more than half of the classified set is edited', () => {
    const { root, ctx } = none();
    const findings = preverifyMigration(
      root,
      ctx,
      classification(CLASSIFIED, CLASSIFIED),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'mass-misread',
      paths: CLASSIFIED,
    });
    expect(findings[0]!.message).toContain('2 of 2');
    expect(findings[0]!.options.map((o) => [o.choice, o.flag])).toEqual([
      ['stop', null],
      ['force', '--force'],
      ['eject-all', '--eject-all'],
    ]);
    expect(findings[0]!.options[1]!.label).toContain('2 edited files');
    expect(findings[0]!.options[2]!.label).toContain('2 edited files');
  });

  it('does not raise at exactly half', () => {
    const { root, ctx } = none();

    expect(
      kinds(root, ctx, classification(CLASSIFIED, [CLASSIFIED[0]!])),
    ).toEqual([]);
  });

  it('does not raise on an empty classified set', () => {
    const { root, ctx } = none();

    expect(kinds(root, ctx, classification([]))).toEqual([]);
  });
});

describe('preverifyMigration, manifest disagrees', () => {
  it('raises for a manifest dest missing from disk when the manifest is tracked', () => {
    const root = repoWith(FILES);
    const ctx = ctxFor(root, { files: { '.claude/rules/gone.md': 'h' } });

    const findings = preverifyMigration(root, ctx, classification(CLASSIFIED));

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'manifest-disagrees',
      paths: ['.claude/rules/gone.md'],
    });
    expect(findings[0]!.options.map((o) => o.flag)).toEqual([
      null,
      '--force',
      '--eject-all',
    ]);
  });

  it('does not count a missing manifest dest that git ignores', () => {
    const root = repoWith({
      ...FILES,
      '.claude/scripts/.gitignore': '*\n!.gitignore\n',
    });
    const ctx = ctxFor(root, {
      files: { '.claude/scripts/guard-bash.mjs': 'h' },
    });

    expect(kinds(root, ctx, classification(CLASSIFIED))).toEqual([]);
  });

  it('counts only the missing dests git does not ignore', () => {
    const root = repoWith({
      ...FILES,
      '.claude/scripts/.gitignore': '*\n!.gitignore\n',
    });
    const ctx = ctxFor(root, {
      files: {
        '.claude/scripts/guard-bash.mjs': 'h',
        '.claude/rules/gone.md': 'h',
      },
    });

    const findings = preverifyMigration(root, ctx, classification(CLASSIFIED));

    expect(findings.map((finding) => finding.paths)).toEqual([
      ['.claude/rules/gone.md'],
    ]);
  });

  it('raises when the config modules differ from the manifest modules', () => {
    const root = repoWith(FILES);
    const ctx = ctxFor(
      root,
      { modules: ['core'] },
      { modules: ['core', 'sweep'] },
    );

    expect(kinds(root, ctx, classification(CLASSIFIED))).toEqual([
      'manifest-disagrees',
    ]);
  });

  it('does not raise when the modules match in another order', () => {
    const root = repoWith(FILES);
    const ctx = ctxFor(
      root,
      { modules: ['core', 'sweep'] },
      { modules: ['sweep', 'core'] },
    );

    expect(kinds(root, ctx, classification(CLASSIFIED))).toEqual([]);
  });

  it('does not raise for a config with no modules key', () => {
    const root = repoWith(FILES);
    const ctx = ctxFor(root, { modules: ['core'] }, {});

    expect(kinds(root, ctx, classification(CLASSIFIED))).toEqual([]);
  });

  it('does not raise when git does not track the manifest', () => {
    const root = repoWith({ '.claude/rules/a.md': 'a\n' });
    const ctx = ctxFor(
      root,
      {
        modules: ['core'],
        files: { '.claude/rules/gone.md': 'h' },
      },
      { modules: ['sweep'] },
    );

    expect(kinds(root, ctx, classification(['.claude/rules/a.md']))).toEqual(
      [],
    );
  });
});

describe('preverifyMigration, staged or unmerged', () => {
  it('raises for a staged edit to a classified path, offering stop alone', () => {
    const root = repoWith(FILES);
    put(root, { '.claude/rules/a.md': 'edited\n' });
    git(root, 'add', '.claude/rules/a.md');

    const findings = preverifyMigration(
      root,
      ctxFor(root, null),
      classification(CLASSIFIED),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'staged-or-unmerged',
      paths: ['.claude/rules/a.md'],
    });
    expect(findings[0]!.options.map((o) => o.choice)).toEqual(['stop']);
  });

  it('raises for a staged edit to the manifest', () => {
    const root = repoWith(FILES);
    put(root, { [MANIFEST_PATH]: '{"x":1}\n' });
    git(root, 'add', MANIFEST_PATH);

    expect(kinds(root, ctxFor(root, null), classification(CLASSIFIED))).toEqual(
      ['staged-or-unmerged'],
    );
  });

  it('does not raise for an unstaged edit', () => {
    const root = repoWith(FILES);
    put(root, { '.claude/rules/a.md': 'edited\n' });

    expect(kinds(root, ctxFor(root, null), classification(CLASSIFIED))).toEqual(
      [],
    );
  });

  it('does not raise for a staged path outside the classified set', () => {
    const root = repoWith({ ...FILES, 'other.txt': 'o\n' });
    put(root, { 'other.txt': 'changed\n' });
    git(root, 'add', 'other.txt');

    expect(kinds(root, ctxFor(root, null), classification(CLASSIFIED))).toEqual(
      [],
    );
  });

  it('raises for an unmerged path', () => {
    const root = repoWith(FILES);
    const main = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    git(root, 'checkout', '-q', '-b', 'side');
    put(root, { '.claude/rules/a.md': 'side\n' });
    git(root, 'commit', '-q', '-am', 'side');
    git(root, 'checkout', '-q', main);
    put(root, { '.claude/rules/a.md': 'main\n' });
    git(root, 'commit', '-q', '-am', 'main');
    spawnSync('git', ['merge', 'side'], { cwd: root });

    const findings = preverifyMigration(
      root,
      ctxFor(root, null),
      classification(CLASSIFIED),
    );

    expect(findings.map((f) => f.kind)).toEqual(['staged-or-unmerged']);
    expect(findings[0]!.paths).toEqual(['.claude/rules/a.md']);
  });

  it('reads cwd-relative paths when .claude sits below the git root', () => {
    const top = repoWith({ 'sub/.claude/rules/a.md': 'a\n' });
    const root = join(top, 'sub');
    put(root, { '.claude/rules/a.md': 'edited\n' });
    git(top, 'add', '-A');

    const findings = preverifyMigration(
      root,
      ctxFor(root, null),
      classification(['.claude/rules/a.md']),
    );

    expect(findings[0]).toMatchObject({
      kind: 'staged-or-unmerged',
      paths: ['.claude/rules/a.md'],
    });
  });
});

describe('preverifyMigration, order', () => {
  it('returns mass misread, then manifest disagrees, then staged or unmerged', () => {
    const root = repoWith(FILES);
    put(root, { '.claude/rules/a.md': 'edited\n' });
    git(root, 'add', '.claude/rules/a.md');
    const ctx = ctxFor(root, { files: { '.claude/rules/gone.md': 'h' } });

    expect(kinds(root, ctx, classification(CLASSIFIED, CLASSIFIED))).toEqual([
      'mass-misread',
      'manifest-disagrees',
      'staged-or-unmerged',
    ]);
  });
});

describe('noTerminalReport', () => {
  it('names each finding, each option with its flag, and that nothing was written', () => {
    const root = repoWith(FILES);
    const findings = preverifyMigration(
      root,
      ctxFor(root, null),
      classification(CLASSIFIED, CLASSIFIED),
    );

    const report = noTerminalReport(findings);

    expect(report).toContain(findings[0]!.message);
    expect(report).toContain('--force');
    expect(report).toContain('--eject-all');
    expect(report.split('\n').at(-1)).toContain('nothing was written');
  });
});
