import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import { hookCommandsFor, settingsOf } from '#test/installed-tree';
import { promptInput } from '#test/hook-input';

const INJECT = '.claude/scripts/ledger-inject.mjs';
const DECIDE = '.claude/scripts/decision-log.mjs';

function decide(root: string, title: string, body: string): string {
  const r = runScript(root, DECIDE, {
    args: ['decide', 'SIM', 'DECISIONS.md', title, body, '--chat=none'],
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim().split('\n')[0];
}

function decideSuperseding(
  root: string,
  targets: string[],
  title: string,
  body: string,
): string {
  const r = runScript(root, DECIDE, {
    args: [
      'decide',
      'SIM',
      'DECISIONS.md',
      title,
      body,
      '--supersedes',
      targets.join(','),
      '--chat=none',
    ],
  });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim().split('\n')[0];
}

describe('ledger-inject.mjs ancestry of a merge', () => {
  it('names every superseded parent, not just the first', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'decisions' });
    const first = decide(root, 'First choice', 'one');
    const second = decide(root, 'Second choice', 'two');
    const merged = decideSuperseding(root, [first, second], 'Merged', 'three');

    const r = runScript(root, INJECT, promptInput(`why ${merged}`));

    expect(r.stdout).toContain(first);
    expect(r.stdout).toContain(second);
  });
});

describe('ledger-inject.mjs', () => {
  describe('backlog entries', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo');
    });

    it('installs the injector and wires it into a UserPromptSubmit hook', () => {
      expect(existsSync(join(root, INJECT))).toBeTruthy();
      const settings = settingsOf(root);
      expect(
        hookCommandsFor(settings, 'UserPromptSubmit').some((c) =>
          c.includes('ledger-inject.mjs'),
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

      const r = runScript(
        root,
        INJECT,
        promptInput(`please pick up ${id} next`),
      );
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

  describe('decision entries', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', { modules: 'decisions' });
    });

    it('injects a decision when the prompt references its ID', () => {
      const decide = runScript(root, '.claude/scripts/decision-log.mjs', {
        args: [
          'decide',
          'ARCH',
          'DECISIONS.md',
          'Use gzip for bodies',
          'smaller log, cheap to decode',
          '--chat=none',
        ],
      });
      expect(decide.status, decide.stderr).toBe(0);
      const id = decide.stdout.trim().split('\n')[0];

      const r = runScript(root, INJECT, promptInput(`re-check ${id} please`));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(new RegExp(id));
      expect(r.stdout).toMatch(/Use gzip for bodies/);
      expect(r.stdout).toMatch(/smaller log, cheap to decode/);
      expect(r.stdout).toMatch(/accepted/);
    });

    it('injects a superseded decision, labelled superseded', () => {
      const decide = runScript(root, '.claude/scripts/decision-log.mjs', {
        args: [
          'decide',
          'ARCH',
          'DECISIONS.md',
          'Use JSON for bodies',
          'plain and simple',
          '--chat=none',
        ],
      });
      const oldId = decide.stdout.trim().split('\n')[0];
      const supersede = runScript(root, '.claude/scripts/decision-log.mjs', {
        args: [
          'supersede',
          oldId,
          'DECISIONS.md',
          'Use gzip for bodies',
          'smaller log',
          '--chat=none',
        ],
      });
      expect(supersede.status, supersede.stderr).toBe(0);

      const r = runScript(
        root,
        INJECT,
        promptInput(`what happened to ${oldId}?`),
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(new RegExp(oldId));
      expect(r.stdout).toMatch(/superseded/);
    });

    it('carries an ancestry line for an injected decision', () => {
      const decide = runScript(root, '.claude/scripts/decision-log.mjs', {
        args: [
          'decide',
          'ARCH',
          'DECISIONS.md',
          'Use JSON for bodies',
          'plain and simple',
          '--chat=none',
        ],
      });
      const oldId = decide.stdout.trim().split('\n')[0];
      const supersede = runScript(root, '.claude/scripts/decision-log.mjs', {
        args: [
          'supersede',
          oldId,
          'DECISIONS.md',
          'Use gzip for bodies',
          'smaller log',
          '--chat=none',
        ],
      });
      const newId = supersede.stdout.trim().split('\n')[0];

      const r = runScript(
        root,
        INJECT,
        promptInput(`re-check ${newId} please`),
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`${oldId} — Use JSON for bodies`));
    });

    it('never prints a superseded ancestor body in the ancestry line', () => {
      const decide = runScript(root, '.claude/scripts/decision-log.mjs', {
        args: [
          'decide',
          'ARCH',
          'DECISIONS.md',
          'Use JSON for bodies',
          'a very distinctive ancestor body marker',
          '--chat=none',
        ],
      });
      const oldId = decide.stdout.trim().split('\n')[0];
      const supersede = runScript(root, '.claude/scripts/decision-log.mjs', {
        args: [
          'supersede',
          oldId,
          'DECISIONS.md',
          'Use gzip for bodies',
          'smaller log',
          '--chat=none',
        ],
      });
      const newId = supersede.stdout.trim().split('\n')[0];

      const r = runScript(
        root,
        INJECT,
        promptInput(`re-check ${newId} please`),
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toMatch(/a very distinctive ancestor body marker/);
    });

    it('injects nothing for an ID present in neither log', () => {
      const r = runScript(root, INJECT, promptInput('what about NOPE-abcdef?'));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });
});
