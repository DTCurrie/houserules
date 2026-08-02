import { beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo, useRepo } from '#test/repo';
import { runScript } from '#test/run';

const SCRIPT = '.claude/scripts/guard-bash.mjs';
const KIT_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const payload = (command: string): string =>
  JSON.stringify({ tool_input: { command } });

function withConfig(root: string, guard: Record<string, unknown>): void {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    join(root, '.claude/kit.config.json'),
    JSON.stringify({ version: 2, guard, targets: [] }),
  );
}

describe('guard-bash', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it.each([
    { cmd: 'git commit -m x' },
    { cmd: 'git push origin main' },
    { cmd: 'git -C /x push' },
    { cmd: 'git stash' },
    { cmd: 'gh pr create --fill' },
    { cmd: 'git -C /repo commit -m x' },
    { cmd: 'git -c user.name=x commit -m y' },
    { cmd: 'git --no-pager commit' },
    { cmd: 'git -C /repo stash' },
    { cmd: 'git add -A && git commit -m x' },
    { cmd: 'make build; git commit -m done' },
  ])('blocks "$cmd" by default', ({ cmd }) => {
    const r = runScript(root, SCRIPT, { input: payload(cmd) });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Blocked by claude-kit guard/);
  });

  it.each([
    { cmd: 'ls -la' },
    { cmd: 'git status' },
    { cmd: 'git log --oneline' },
    { cmd: 'pnpm run build' },
    { cmd: 'grep -rn "git commit" .' },
    { cmd: 'echo "remember to git commit when done"' },
    { cmd: 'node -e \'console.log("git stash")\'' },
    { cmd: 'rg "git push" src/' },
    { cmd: 'git log --grep "git commit"' },
  ])(
    'allows "$cmd" by default, since flags and quoted arguments must not be mistaken for the guarded subcommand',
    ({ cmd }) => {
      const r = runScript(root, SCRIPT, { input: payload(cmd) });
      expect(r.status, r.stderr).toBe(0);
    },
  );

  it('blocks by default even without a kit.config.json, since the payload script falls back to hardcoded defaults', () => {
    const bare = useRepo('non-js');
    const r = spawnSync(
      process.execPath,
      [join(KIT_ROOT, 'payload-dist/scripts/guard-bash.mjs')],
      {
        cwd: bare,
        input: payload('git commit -m x'),
        encoding: 'utf8',
      },
    );
    expect(r.status).toBe(2);
  });

  it('allows a rule that config disables, while leaving the other defaults on', () => {
    withConfig(root, { gitStash: false });
    expect(
      runScript(root, SCRIPT, { input: payload('git stash') }).status,
    ).toBe(0);
    expect(
      runScript(root, SCRIPT, { input: payload('git commit -m x') }).status,
    ).toBe(2);
  });

  it('blocks a command matching a custom rule and reports its message', () => {
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
  });

  it('allows Bash to proceed when a custom rule has an invalid regex', () => {
    withConfig(root, { custom: [{ pattern: '(unclosed' }] });
    expect(runScript(root, SCRIPT, { input: payload('ls') }).status).toBe(0);
  });

  it('allows Bash to proceed on stdin that is not valid JSON', () => {
    expect(runScript(root, SCRIPT, { input: 'not json at all' }).status).toBe(
      0,
    );
  });
});
