import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  detect,
  detectFixCommands,
  detectVerifyCommands,
  suggestPrefix,
  trackedLedgerLogs,
  trackedLedgerSurfaces,
  trackedScriptFiles,
  untrackFromIndex,
} from '../detect.js';
import { renderKitConfig } from '../render.js';
import { useRepo } from '#test/repo';
import { runIn } from '#test/run';

describe('detectFixCommands', () => {
  it('returns null for an empty scripts bag', () => {
    expect(detectFixCommands({})).toBe(null);
  });

  it('returns null when called with no argument', () => {
    expect(detectFixCommands()).toBe(null);
  });

  it.each([
    {
      name: 'a lone fix script',
      scripts: { fix: 'wireit' },
      expected: ['fix'],
    },
    {
      name: 'fix winning over lint:fix and format:fix, to avoid duplicating the wired parts',
      scripts: {
        fix: 'wireit',
        'lint:fix': 'eslint --fix',
        'format:fix': 'prettier --write .',
      },
      expected: ['fix'],
    },
    {
      name: 'lint:fix and format:fix together',
      scripts: {
        'lint:fix': 'eslint --fix',
        'format:fix': 'prettier --write .',
      },
      expected: ['lint:fix', 'format:fix'],
    },
    {
      name: 'lint:fix alone',
      scripts: { 'lint:fix': 'eslint --fix' },
      expected: ['lint:fix'],
    },
    {
      name: 'a writing format script alongside a separate format:check, since format:check is not a fixer',
      scripts: {
        format: 'prettier --write .',
        'format:check': 'prettier --check .',
      },
      expected: ['format'],
    },
    {
      name: 'format:fix taking precedence over a writing format script',
      scripts: {
        'format:fix': 'biome format --write .',
        format: 'prettier --write .',
      },
      expected: ['format:fix'],
    },
    {
      name: 'a bare writing format script with no lint:fix',
      scripts: { format: 'prettier -w .' },
      expected: ['format'],
    },
  ])('resolves $name to $expected', ({ scripts, expected }) => {
    expect(detectFixCommands(scripts)).toEqual(expected);
  });

  it.each([
    {
      name: 'only non-fixer scripts',
      scripts: { test: 'vitest run', lint: 'eslint .' },
    },
    {
      name: 'a checking-only format script',
      scripts: { format: 'prettier --check .' },
    },
    {
      name: 'a format script using --list-different, which only reports',
      scripts: { format: 'prettier --list-different .' },
    },
    { name: 'a non-string fix script value', scripts: { fix: undefined } },
  ])('returns null for $name', ({ scripts }) => {
    expect(detectFixCommands(scripts)).toBe(null);
  });
});

describe('detectVerifyCommands', () => {
  it('returns null for an empty scripts bag', () => {
    expect(detectVerifyCommands({})).toBe(null);
  });

  it('returns null when called with no argument', () => {
    expect(detectVerifyCommands()).toBe(null);
  });

  it.each([
    {
      name: 'a lone verify script',
      scripts: { verify: 'wireit' },
      expected: ['verify'],
    },
    {
      name: 'verify winning over typecheck, test, and lint, since they are wired underneath it',
      scripts: {
        verify: 'wireit',
        typecheck: 'tsc --noEmit',
        test: 'vitest run',
        lint: 'eslint .',
      },
      expected: ['verify'],
    },
    {
      name: 'typecheck, test, and lint together, in that order',
      scripts: {
        lint: 'eslint .',
        test: 'vitest run',
        typecheck: 'tsc --noEmit',
      },
      expected: ['typecheck', 'test', 'lint'],
    },
    {
      name: 'typecheck taking precedence over check when both exist',
      scripts: {
        typecheck: 'tsc --noEmit',
        check: 'tsc --noEmit -p tsconfig.json',
      },
      expected: ['typecheck'],
    },
    {
      name: 'check alone when there is no typecheck script',
      scripts: { check: 'tsc --noEmit' },
      expected: ['check'],
    },
    {
      name: 'test alone',
      scripts: { test: 'vitest run' },
      expected: ['test'],
    },
    {
      name: 'lint alone',
      scripts: { lint: 'eslint .' },
      expected: ['lint'],
    },
  ])('resolves $name to $expected', ({ scripts, expected }) => {
    expect(detectVerifyCommands(scripts)).toEqual(expected);
  });

  it('returns null for a scripts bag with no recognized gate script', () => {
    expect(detectVerifyCommands({ build: 'tsc', start: 'node .' })).toBe(null);
  });
});

describe('suggestPrefix', () => {
  it.each([
    { name: 'single-app', expected: 'SINGLEAPP' },
    { name: '@schoolyard/cityville', expected: 'CITYVILLE' },
    { name: 'my-cool-lib', expected: 'MYCOOLLIB' },
    { name: '@scope/pkg-with-dashes', expected: 'PKGWITHDASHE' },
    { name: '123-starts-with-digits', expected: 'STARTSWITHDI' },
    {
      name: 'a-very-long-package-name-that-exceeds-twelve',
      expected: 'AVERYLONGPAC',
    },
  ])('suggests $expected for package name $name', ({ name, expected }) => {
    expect(suggestPrefix(name)).toBe(expected);
  });

  it('falls back to PKG when the cleaned name is empty', () => {
    expect(suggestPrefix('@scope/123')).toBe('PKG');
  });
});

describe('detect', () => {
  describe('on a pnpm monorepo (schoolyard shape)', () => {
    let ctx: ReturnType<typeof detect>;

    beforeEach(() => {
      const root = useRepo('pnpm-monorepo');
      ctx = detect(root);
    });

    it('resolves the pnpm package manager and version from the packageManager field', () => {
      expect(ctx.packageManager!.name).toBe('pnpm');
      expect(ctx.packageManager!.version).toBe('11.5.0');
      expect(ctx.packageManager!.source).toBe('packageManager');
    });

    it('finds only the packages with a package.json, ignoring empty workspace dirs', () => {
      expect(ctx.packages.map((p) => p.name).sort()).toEqual([
        '@fix/cityville',
        '@fix/studio',
      ]);
    });

    it('resolves a target’s path prefix and source path from its package location', () => {
      const studio = ctx.targets.find((t) => t.packageName === '@fix/studio')!;
      expect(studio.pathPrefix).toBe('apps/studio/');
      expect(studio.sourcePath).toBe('apps/studio/src');
      expect(studio.prefix).toBe('STUDIO');
    });

    it('detects TypeScript, monorepo shape, and strict catalog mode', () => {
      expect(ctx.typescript).toBe(true);
      expect(ctx.isMonorepo).toBe(true);
      expect(ctx.pnpmCatalogModeStrict).toBe(true);
    });

    it('counts pending changesets, excluding README.md', () => {
      expect(ctx.changesets.configExists).toBe(true);
      expect(ctx.changesets.pendingCount).toBe(2);
      expect(ctx.changesets.devDep).toBe(false);
    });

    it('resolves the changesets invocation as a root script with its base branch', () => {
      expect(ctx.changesets.invocation).toBe('root-script');
      expect(ctx.changesets.rootScript).toBe('change');
      expect(ctx.changesets.baseBranch).toBe('main');
    });

    it('reflects existing claude state: settings.local present, settings and CLAUDE.md absent', () => {
      expect(ctx.claude.settingsLocalExists).toBe(true);
      expect(ctx.claude.settingsExists).toBe(false);
      expect(ctx.claude.claudeMdExists).toBe(false);
    });
  });

  describe('on an npm single-package repo', () => {
    let ctx: ReturnType<typeof detect>;

    beforeEach(() => {
      const root = useRepo('npm-single');
      ctx = detect(root);
    });

    it('resolves npm as the package manager and treats the repo as a single package', () => {
      expect(ctx.packageManager!.name).toBe('npm');
      expect(ctx.isMonorepo).toBe(false);
      expect(ctx.targets.length).toBe(1);
    });

    it('resolves the single target at the repo root using its lint:fix script', () => {
      const t = ctx.targets[0];
      if (!t) throw new Error('expected a target');
      expect(t.pathPrefix).toBe('');
      expect(t.sourcePath).toBe('src');
      expect(t.fixCommands).toEqual(['lint:fix']);
    });

    it('reports no TypeScript and no changesets config', () => {
      expect(ctx.typescript).toBe(false);
      expect(ctx.changesets.configExists).toBe(false);
      expect(ctx.changesets.invocation).toBe('absent');
    });

    it('detects the pre-existing CLAUDE.md', () => {
      expect(ctx.claude.claudeMdExists).toBe(true);
    });
  });

  it('pairs lint:fix with a bare write-format script that has no format:fix, and leaves filterFlag empty so a single-package repo never gets a --filter that would run against a nonexistent workspace (AGENTKIT-4e98d7)', () => {
    const root = useRepo('pnpm-single');
    const ctx = detect(root);
    expect(ctx.packageManager!.name).toBe('pnpm');
    expect(ctx.isMonorepo).toBe(false);
    expect(ctx.targets.length).toBe(1);
    const target = ctx.targets[0];
    if (!target) throw new Error('expected a target');
    expect(target.fixCommands).toEqual(['lint:fix', 'format']);

    const config = JSON.parse(
      renderKitConfig(ctx, {
        moduleIds: ['lint-fix'],
        targets: ctx.targets,
        seedChangesetConfig: false,
        moduleOptions: {},
      }),
    ) as { fix: { runner: string; filterFlag: string } };
    expect(config.fix.runner).toBe('pnpm');
    expect(config.fix.filterFlag).toBe('');
  });

  it('does not crash on a repo with no package.json', () => {
    const root = useRepo('non-js');
    const ctx = detect(root);
    expect(ctx.packageManager).toBe(null);
    expect(ctx.targets).toEqual([]);
    expect(ctx.changesets.invocation).toBe('absent');
    expect(ctx.git.isRepo).toBe(true);
  });

  it('reaches targets end to end through a flow-sequence workspace glob, a ** glob, and a negation', () => {
    const root = useRepo('pnpm-flow-monorepo');
    const ctx = detect(root);
    expect(ctx.isMonorepo).toBe(true);
    expect(ctx.packages.map((p) => p.name).sort()).toEqual([
      '@flow/nested',
      '@flow/plain',
    ]);

    const nested = ctx.targets.find((t) => t.packageName === '@flow/nested')!;
    expect(nested.pathPrefix).toBe('libs/group/nested/');
    expect(nested.sourcePath).toBe('libs/group/nested/src');
    expect(ctx.targets.some((t) => t.packageName === '@flow/legacy')).toBe(
      false,
    );
  });
});

describe('detect, ctx.prettier', () => {
  it('is true when prettier is a devDependency', () => {
    const root = useRepo('npm-single-prettier');
    expect(detect(root).prettier).toBe(true);
  });

  it('is true when a prettier config file exists with no dependency', () => {
    const root = useRepo('npm-single');
    writeFileSync(join(root, '.prettierrc.json'), '{}\n');
    expect(detect(root).prettier).toBe(true);
  });

  it('is true when a .prettierignore already exists with no dependency', () => {
    const root = useRepo('npm-single');
    writeFileSync(join(root, '.prettierignore'), 'dist/\n');
    expect(detect(root).prettier).toBe(true);
  });

  it('is false for a repo with neither a dependency nor a config file', () => {
    const root = useRepo('npm-single');
    expect(detect(root).prettier).toBe(false);
  });

  it('is false for a bare repo with no package.json', () => {
    const root = useRepo('non-js');
    expect(detect(root).prettier).toBe(false);
  });
});

describe('trackedScriptFiles and untrackFromIndex', () => {
  it('finds every kit script committed by a pre-gitignore install', () => {
    const root = useRepo('committed-scripts');
    expect(trackedScriptFiles(root).sort()).toEqual(
      [
        '.claude/scripts/changeset-check.mjs',
        '.claude/scripts/guard-bash.mjs',
        '.claude/scripts/session-context.mjs',
      ].sort(),
    );
  });

  it('stages the removal from the index without deleting the working-tree files', () => {
    const root = useRepo('committed-scripts');
    const tracked = trackedScriptFiles(root);

    expect(untrackFromIndex(root, tracked)).toBe(true);

    expect(trackedScriptFiles(root)).toEqual([]);
    expect(
      tracked.filter((rel) => !existsSync(join(root, rel))),
      'untracking deleted these from the working tree',
    ).toEqual([]);
  });
});

function commitAll(root: string): void {
  runIn(root, 'git', ['add', '-A']);
  runIn(root, 'git', ['commit', '-qm', 'fixture: ledger']);
}

describe('trackedLedgerSurfaces, nested per-area surfaces', () => {
  it('offers a nested surface a pre-move ledger entry records by repo-relative path', () => {
    const root = useRepo('non-js');
    mkdirSync(join(root, '.claude/ledgers'), { recursive: true });
    writeFileSync(
      join(root, '.claude/ledgers/backlog.jsonl'),
      `${JSON.stringify({ id: 'B1', file: 'games/tower-push/BACKLOG.md' })}\n`,
    );
    mkdirSync(join(root, 'games/tower-push'), { recursive: true });
    writeFileSync(join(root, 'games/tower-push/BACKLOG.md'), '# Backlog\n');
    commitAll(root);

    expect(trackedLedgerSurfaces(root, '.claude/ledgers')).toEqual([
      'games/tower-push/BACKLOG.md',
    ]);
  });

  it('leaves alone a nested file no ledger entry names', () => {
    const root = useRepo('non-js');
    mkdirSync(join(root, '.claude/ledgers'), { recursive: true });
    writeFileSync(
      join(root, '.claude/ledgers/backlog.jsonl'),
      `${JSON.stringify({ id: 'B1', file: 'BACKLOG.md' })}\n`,
    );
    mkdirSync(join(root, 'apps/foo'), { recursive: true });
    writeFileSync(join(root, 'apps/foo/BACKLOG.md'), '# hand-written\n');
    commitAll(root);

    expect(trackedLedgerSurfaces(root, '.claude/ledgers')).toEqual([]);
  });

  it('skips unparseable lines instead of throwing', () => {
    const root = useRepo('non-js');
    mkdirSync(join(root, '.claude/ledgers'), { recursive: true });
    writeFileSync(
      join(root, '.claude/ledgers/backlog.jsonl'),
      `not json\n${JSON.stringify({ id: 'B1', file: 'games/tower-push/BACKLOG.md' })}\n`,
    );
    mkdirSync(join(root, 'games/tower-push'), { recursive: true });
    writeFileSync(join(root, 'games/tower-push/BACKLOG.md'), '# Backlog\n');
    commitAll(root);

    expect(trackedLedgerSurfaces(root, '.claude/ledgers')).toEqual([
      'games/tower-push/BACKLOG.md',
    ]);
  });
});

describe('trackedLedgerLogs', () => {
  it('reports both committed ledger jsonl files by repo-relative path', () => {
    const root = useRepo('non-js');
    mkdirSync(join(root, '.claude/ledgers'), { recursive: true });
    writeFileSync(
      join(root, '.claude/ledgers/backlog.jsonl'),
      `${JSON.stringify({ id: 'B1', file: 'BACKLOG.md' })}\n`,
    );
    writeFileSync(
      join(root, '.claude/ledgers/decisions.jsonl'),
      `${JSON.stringify({ id: 'D1', file: 'DECISIONS.md' })}\n`,
    );
    commitAll(root);

    expect(trackedLedgerLogs(root, '.claude/ledgers').sort()).toEqual(
      [
        '.claude/ledgers/backlog.jsonl',
        '.claude/ledgers/decisions.jsonl',
      ].sort(),
    );
  });

  it('reports nothing for jsonl files that exist on disk but are not tracked by git', () => {
    const root = useRepo('non-js');
    mkdirSync(join(root, '.claude/ledgers'), { recursive: true });
    writeFileSync(
      join(root, '.claude/ledgers/backlog.jsonl'),
      `${JSON.stringify({ id: 'B1', file: 'BACKLOG.md' })}\n`,
    );

    expect(trackedLedgerLogs(root, '.claude/ledgers')).toEqual([]);
  });

  it('leaves a committed markdown surface for trackedLedgerSurfaces to own', () => {
    const root = useRepo('non-js');
    mkdirSync(join(root, '.claude/ledgers'), { recursive: true });
    writeFileSync(
      join(root, '.claude/ledgers/backlog.jsonl'),
      `${JSON.stringify({ id: 'B1', file: 'BACKLOG.md' })}\n`,
    );
    writeFileSync(join(root, '.claude/ledgers/BACKLOG.md'), '# Backlog\n');
    commitAll(root);

    expect(trackedLedgerLogs(root, '.claude/ledgers')).toEqual([
      '.claude/ledgers/backlog.jsonl',
    ]);
  });

  it('returns an empty array when the ledger directory does not exist', () => {
    const root = useRepo('non-js');

    expect(trackedLedgerLogs(root, '.claude/ledgers')).toEqual([]);
  });

  it('ignores a jsonl file committed outside the ledger directory', () => {
    const root = useRepo('non-js');
    mkdirSync(join(root, '.claude/ledgers'), { recursive: true });
    writeFileSync(
      join(root, '.claude/ledgers/backlog.jsonl'),
      `${JSON.stringify({ id: 'B1', file: 'BACKLOG.md' })}\n`,
    );
    writeFileSync(join(root, 'other.jsonl'), '{}\n');
    commitAll(root);

    expect(trackedLedgerLogs(root, '.claude/ledgers')).toEqual([
      '.claude/ledgers/backlog.jsonl',
    ]);
  });
});
