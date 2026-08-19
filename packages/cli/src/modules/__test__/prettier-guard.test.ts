import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { useInstalledRepo, treeHash } from '#test/repo';
import { makeAnswers, makeCtx, makeRegistry } from '#test/ctx-builder';
import { buildPlan, MODULES } from '../../plan.js';
import { prettierGuardActions } from '../prettier-guard.js';

describe('the .prettierignore block against the enabled module set', () => {
  function plansTheBlock(moduleIds: string[]): boolean {
    const actions = buildPlan(
      makeCtx({ prettier: true }),
      makeAnswers({ moduleIds }),
      makeRegistry(MODULES),
    );
    return actions.some(
      (a) => a.kind === 'region' && a.dest === '.prettierignore',
    );
  }

  it('plans the block with lint-fix disabled, since a prettier repo with no fix script still needs it', () => {
    expect(plansTheBlock(['core'])).toBe(true);
  });

  it('plans the block exactly once when lint-fix is also enabled', () => {
    const actions = buildPlan(
      makeCtx({ prettier: true }),
      makeAnswers({ moduleIds: ['core', 'lint-fix'] }),
      makeRegistry(MODULES),
    );

    const blocks = actions.filter(
      (a) => a.kind === 'region' && a.dest === '.prettierignore',
    );
    expect(blocks).toHaveLength(1);
  });
});

const require = createRequire(import.meta.url);
const PRETTIER_CLI = require.resolve('prettier/bin/prettier.cjs');

describe('prettierGuardActions, .prettierignore protection', () => {
  it('plans a region action for the .prettierignore block when the repo has prettier', () => {
    const ctx = makeCtx({ prettier: true });

    const actions = prettierGuardActions(ctx, []);

    const region = actions.find(
      (a): a is Extract<typeof a, { kind: 'region' }> =>
        a.kind === 'region' && a.dest === '.prettierignore',
    );
    expect(region?.body).toContain('.claude/houserules.manifest.json');
  });

  it('protects .claude/houserules.config.json even though it is a user-owned seed', () => {
    const ctx = makeCtx({ prettier: true });

    const actions = prettierGuardActions(ctx, []);

    const region = actions.find(
      (a): a is Extract<typeof a, { kind: 'region' }> =>
        a.kind === 'region' && a.dest === '.prettierignore',
    );
    expect(region?.body).toContain('.claude/houserules.config.json');
  });

  it('plans no .prettierignore action for a repo without prettier', () => {
    const ctx = makeCtx({ prettier: false });

    const actions = prettierGuardActions(ctx, []);

    expect(
      actions.some((a) => a.kind === 'region' && a.dest === '.prettierignore'),
    ).toBe(false);
  });

  it('protects only the first path segment under .claude/, not each file it contains', () => {
    const ctx = makeCtx({ prettier: true });
    const plan = [
      {
        kind: 'copy' as const,
        src: '/payload/skills/tidy/SKILL.md',
        dest: '.claude/skills/tidy/SKILL.md',
        module: 'tidy',
        reason: 'tidy skill',
      },
      {
        kind: 'copy' as const,
        src: '/payload/skills/sweep/SKILL.md',
        dest: '.claude/skills/sweep/SKILL.md',
        module: 'sweep',
        reason: 'sweep skill',
      },
    ];

    const actions = prettierGuardActions(ctx, plan);

    const region = actions.find(
      (a): a is Extract<typeof a, { kind: 'region' }> =>
        a.kind === 'region' && a.dest === '.prettierignore',
    );
    expect(region?.body).toContain('.claude/skills/');
    expect(region?.body).not.toContain('.claude/skills/tidy/');
  });
});

describe('prettierGuardActions, eslint flat config advisory', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lint-fix-eslint-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  });

  function adviseTexts(
    actions: ReturnType<typeof prettierGuardActions>,
  ): string[] {
    return actions
      .filter(
        (a): a is Extract<typeof a, { kind: 'advise' }> => a.kind === 'advise',
      )
      .map((a) => a.text);
  }

  it('advises the ignores entry to paste when an eslint flat config exists at the root', () => {
    writeFileSync(join(root, 'eslint.config.js'), 'export default [];\n');
    const ctx = makeCtx({ root });

    const actions = prettierGuardActions(ctx, []);

    const advice = adviseTexts(actions).find((t) => t.includes('eslint'));
    expect(advice).toMatch(/ignores/);
  });

  it('does not advise when there is no eslint flat config at the root', () => {
    const ctx = makeCtx({ root });

    const actions = prettierGuardActions(ctx, []);

    expect(adviseTexts(actions).some((t) => t.includes('eslint'))).toBe(false);
  });
});

describe('the .prettierignore block against a real prettier run', () => {
  const PROTECTED_SUBTREES = [
    '.claude/agents',
    '.claude/templates',
    '.claude/reference',
    '.claude/rules',
    '.claude/scripts',
    '.claude/skills',
  ];

  it('leaves every protected subtree byte-for-byte unchanged after `prettier --write .`', () => {
    const root = useInstalledRepo('npm-single-prettier');
    expect(existsSync(join(root, '.prettierignore'))).toBe(true);
    const present = PROTECTED_SUBTREES.filter((dir) =>
      existsSync(join(root, dir)),
    );
    expect(present.length).toBeGreaterThan(0);
    const before = present.map((dir) => treeHash(join(root, dir)));

    execFileSync(
      process.execPath,
      [PRETTIER_CLI, '--write', '.', '--ignore-unknown'],
      { cwd: root },
    );

    const after = present.map((dir) => treeHash(join(root, dir)));
    expect(after).toEqual(before);
  });

  it('leaves .claude/houserules.manifest.json byte-for-byte unchanged after `prettier --write .`', () => {
    const root = useInstalledRepo('npm-single-prettier');
    const manifestPath = join(root, '.claude/houserules.manifest.json');
    const before = readFileSync(manifestPath, 'utf8');

    execFileSync(
      process.execPath,
      [PRETTIER_CLI, '--write', '.', '--ignore-unknown'],
      { cwd: root },
    );

    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });
});
