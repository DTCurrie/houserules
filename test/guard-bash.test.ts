import { expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeFixture, runCli, runScript } from './fixtures.js';

const SCRIPT = '.claude/scripts/guard-bash.mjs';
const KIT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const payload = (command: string): string =>
  JSON.stringify({ tool_input: { command } });

function withConfig(root: string, guard: Record<string, unknown>): void {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude/kit.config.json'),
    JSON.stringify({ version: 2, guard, targets: [] }),
  );
}

test('G1: defaults block commit/push/stash/pr-create; benign commands pass; no config needed', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    for (const cmd of [
      'git commit -m x',
      'git push origin main',
      'git -C /x push',
      'git stash',
      'gh pr create --fill',
    ]) {
      const r = runScript(root, SCRIPT, { input: payload(cmd) });
      expect(r.status, `should block: ${cmd}`).toBe(2);
      expect(r.stderr).toMatch(/Blocked by claude-kit guard/);
    }
    for (const cmd of [
      'ls -la',
      'git status',
      'git log --oneline',
      'pnpm run build',
    ]) {
      expect(
        runScript(root, SCRIPT, { input: payload(cmd) }).status,
        `should allow: ${cmd}`,
      ).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // No kit.config.json at all (payload script run directly) → hardcoded defaults.
  const bare = makeFixture('non-js');
  try {
    const r = spawnSync(
      process.execPath,
      [join(KIT_ROOT, 'payload-dist/scripts/guard-bash.mjs')],
      {
        cwd: bare,
        input: payload('git commit -m x'),
        encoding: 'utf8',
      },
    );
    expect(r.status, 'defaults must apply without config').toBe(2);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});

test('G3: flag-tolerant under-block + command-position over-block (CLAUDEKIT-fe4d6d)', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    // (1) Under-block fixed: flags before the subcommand must NOT let commit/stash slip
    // through, and a guarded command after a separator must still be caught.
    for (const cmd of [
      'git -C /repo commit -m x',
      'git -c user.name=x commit -m y',
      'git --no-pager commit',
      'git -C /repo stash',
      'git add -A && git commit -m x',
      'make build; git commit -m done',
    ]) {
      const r = runScript(root, SCRIPT, { input: payload(cmd) });
      expect(r.status, `should block: ${cmd}`).toBe(2);
    }

    // (2) Over-block fixed: the same words inside another command's argument must PASS.
    for (const cmd of [
      'grep -rn "git commit" .',
      'echo "remember to git commit when done"',
      'node -e \'console.log("git stash")\'',
      'rg "git push" src/',
      'git log --grep "git commit"',
    ]) {
      const r = runScript(root, SCRIPT, { input: payload(cmd) });
      expect(
        r.status,
        `should allow: ${cmd} (got ${r.status}: ${r.stderr})`,
      ).toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('G2: config toggles rules, custom rules fire, invalid regex skipped, garbage stdin passes', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    withConfig(root, { gitStash: false });
    expect(
      runScript(root, SCRIPT, { input: payload('git stash') }).status,
      'gitStash:false allows',
    ).toBe(0);
    expect(
      runScript(root, SCRIPT, { input: payload('git commit -m x') }).status,
      'other defaults stay on',
    ).toBe(2);

    withConfig(root, {
      custom: [
        { pattern: '\\bdocker\\s+system\\s+prune\\b', message: 'ask first' },
      ],
    });
    const r = runScript(root, SCRIPT, {
      input: payload('docker system prune -f'),
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/ask first/);

    withConfig(root, { custom: [{ pattern: '(unclosed' }] });
    expect(
      runScript(root, SCRIPT, { input: payload('ls') }).status,
      'invalid regex must not break Bash',
    ).toBe(0);

    expect(runScript(root, SCRIPT, { input: 'not json at all' }).status).toBe(
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
