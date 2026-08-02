import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import { hookCommandsFor, settingsOf } from '#test/installed-tree';
import { promptInput } from '#test/hook-input';

describe('backlog-inject.mjs', () => {
  const INJECT = '.claude/scripts/backlog-inject.mjs';
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('installs the injector and wires it into a UserPromptSubmit hook', () => {
    expect(existsSync(join(root, INJECT))).toBeTruthy();
    const settings = settingsOf(root);
    expect(
      hookCommandsFor(settings, 'UserPromptSubmit').some((c) =>
        c.includes('backlog-inject.mjs'),
      ),
    ).toBeTruthy();
  });

  it('injects a logged entry when the prompt references its ID', () => {
    const add = runScript(root, '.claude/scripts/backlog-log.mjs', {
      args: [
        'add',
        'TEST',
        'BACKLOG.md',
        'Cache the token',
        'body: memoize it',
        '--chat=none',
      ],
    });
    expect(add.status, add.stderr).toBe(0);
    const id = add.stdout.trim().split('\n')[0];
    expect(id).toMatch(/^TEST-[0-9a-f]{6}$/);

    const r = runScript(root, INJECT, promptInput(`please pick up ${id} next`));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(id));
    expect(r.stdout).toMatch(/Cache the token/);
    expect(r.stdout).toMatch(/memoize it/);
  });

  it('injects nothing for an unknown but well-formed ID', () => {
    const r = runScript(root, INJECT, promptInput('what about FAKE-abcdef?'));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('injects nothing when the prompt has no ID', () => {
    const r = runScript(root, INJECT, promptInput('just a normal prompt'));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });
});
