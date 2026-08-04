import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import { hookCommandsFor, settingsOf } from '#test/installed-tree';
import { promptInput } from '#test/hook-input';

const INJECT = '.claude/scripts/ledger-inject.mjs';

interface BacklogRecord {
  id: string;
  action: 'add' | 'update' | 'remove';
  title?: string;
  file?: string;
  content?: string;
}

interface DecisionRecord {
  id: string;
  action: 'decide' | 'supersede' | 'amend';
  title?: string;
  file?: string;
  supersedes?: string[];
  content?: string;
}

function encodeBody(body: string): string {
  return gzipSync(Buffer.from(body, 'utf8')).toString('base64');
}

function appendLog(root: string, rel: string, record: unknown): void {
  const path = join(root, rel);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: 'a' });
}

function addBacklogEntry(
  root: string,
  id: string,
  title: string,
  body: string,
): void {
  appendLog(root, '.claude/ledgers/backlog.jsonl', {
    id,
    action: 'add',
    title,
    file: 'BACKLOG.md',
    content: encodeBody(body),
  } satisfies BacklogRecord);
}

function decideEntry(
  root: string,
  id: string,
  title: string,
  body: string,
  supersedes: string[] = [],
): void {
  appendLog(root, '.claude/ledgers/decisions.jsonl', {
    id,
    action: 'decide',
    title,
    file: 'DECISIONS.md',
    supersedes,
    content: encodeBody(body),
  } satisfies DecisionRecord);
}

describe('ledger-inject.mjs ancestry of a merge', () => {
  it('names every superseded parent, not just the first', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    decideEntry(root, 'SIM-100001', 'First choice', 'one');
    decideEntry(root, 'SIM-100002', 'Second choice', 'two');
    decideEntry(root, 'SIM-100003', 'Merged', 'three', [
      'SIM-100001',
      'SIM-100002',
    ]);

    const r = runScript(root, INJECT, promptInput('why SIM-100003'));

    expect(r.stdout).toContain('SIM-100001');
    expect(r.stdout).toContain('SIM-100002');
  });
});

describe('ledger-inject.mjs', () => {
  describe('backlog entries', () => {
    it('installs the injector and wires it into a UserPromptSubmit hook', () => {
      const root = useInstalledRepo('pnpm-monorepo');

      expect(existsSync(join(root, INJECT))).toBeTruthy();
      const settings = settingsOf(root);
      expect(
        hookCommandsFor(settings, 'UserPromptSubmit').some((c) =>
          c.includes('ledger-inject.mjs'),
        ),
      ).toBeTruthy();
    });

    it('injects a logged entry when the prompt references its ID', () => {
      const root = useInstalledRepo('pnpm-monorepo');
      addBacklogEntry(root, 'TEST-abcdef', 'Cache the token', 'memoize it');

      const r = runScript(
        root,
        INJECT,
        promptInput('please pick up TEST-abcdef next'),
      );

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/TEST-abcdef/);
      expect(r.stdout).toMatch(/Cache the token/);
      expect(r.stdout).toMatch(/memoize it/);
    });

    it('injects nothing for an unknown but well-formed ID', () => {
      const root = useInstalledRepo('pnpm-monorepo');

      const r = runScript(root, INJECT, promptInput('what about FAKE-abcdef?'));

      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('injects nothing when the prompt has no ID', () => {
      const root = useInstalledRepo('pnpm-monorepo');

      const r = runScript(root, INJECT, promptInput('just a normal prompt'));

      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  describe('decision entries', () => {
    it('injects a decision when the prompt references its ID', () => {
      const root = useInstalledRepo('pnpm-monorepo');
      decideEntry(
        root,
        'ARCH-100001',
        'Use gzip for bodies',
        'smaller log, cheap to decode',
      );

      const r = runScript(
        root,
        INJECT,
        promptInput('re-check ARCH-100001 please'),
      );

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/ARCH-100001/);
      expect(r.stdout).toMatch(/Use gzip for bodies/);
      expect(r.stdout).toMatch(/smaller log, cheap to decode/);
      expect(r.stdout).toMatch(/accepted/);
    });

    it('injects a superseded decision, labelled superseded', () => {
      const root = useInstalledRepo('pnpm-monorepo');
      decideEntry(
        root,
        'ARCH-100001',
        'Use JSON for bodies',
        'plain and simple',
      );
      decideEntry(root, 'ARCH-100002', 'Use gzip for bodies', 'smaller log', [
        'ARCH-100001',
      ]);

      const r = runScript(
        root,
        INJECT,
        promptInput('what happened to ARCH-100001?'),
      );

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/ARCH-100001/);
      expect(r.stdout).toMatch(/superseded/);
    });

    it('carries an ancestry line for an injected decision', () => {
      const root = useInstalledRepo('pnpm-monorepo');
      decideEntry(
        root,
        'ARCH-100001',
        'Use JSON for bodies',
        'plain and simple',
      );
      decideEntry(root, 'ARCH-100002', 'Use gzip for bodies', 'smaller log', [
        'ARCH-100001',
      ]);

      const r = runScript(
        root,
        INJECT,
        promptInput('re-check ARCH-100002 please'),
      );

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/ARCH-100001 — Use JSON for bodies/);
    });

    it('never prints a superseded ancestor body in the ancestry line', () => {
      const root = useInstalledRepo('pnpm-monorepo');
      decideEntry(
        root,
        'ARCH-100001',
        'Use JSON for bodies',
        'a very distinctive ancestor body marker',
      );
      decideEntry(root, 'ARCH-100002', 'Use gzip for bodies', 'smaller log', [
        'ARCH-100001',
      ]);

      const r = runScript(
        root,
        INJECT,
        promptInput('re-check ARCH-100002 please'),
      );

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toMatch(/a very distinctive ancestor body marker/);
    });

    it('injects nothing for an ID present in neither log', () => {
      const root = useInstalledRepo('pnpm-monorepo');

      const r = runScript(root, INJECT, promptInput('what about NOPE-abcdef?'));

      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });
  describe('a ledger left at a pre-move path', () => {
    it('injects a backlog entry after migrating the legacy .log into place', () => {
      const root = useInstalledRepo('pnpm-monorepo');
      appendLog(root, '.claude/backlog.log', {
        id: 'SIM-aaaaaa',
        action: 'add',
        title: 'legacy located entry',
        file: 'BACKLOG.md',
        content: encodeBody('body'),
      } satisfies BacklogRecord);

      const r = runScript(
        root,
        INJECT,
        promptInput('what is SIM-aaaaaa about'),
      );

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/legacy located entry/);
    });
  });
});
