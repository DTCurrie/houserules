import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import { hookCommandsFor, settingsOf } from '#test/installed-tree';
import { promptInput } from '#test/hook-input';

import {
  capInjectedText,
  MAX_INJECTED_CHARS,
  resolveEntries,
} from '../ledger-inject.mjs';
import { emptyIndex, serializeIndex } from '@houserules/payload/ledger-index';
import type {
  LedgerEntry,
  LedgerIndex,
} from '@houserules/payload/ledger-index';

const INJECT = '.claude/scripts/ledger-inject.mjs';

function ledgerEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: 'BACKLOG-abc123',
    itemId: 'item-1',
    issue: 42,
    title: 'Fix the thing',
    body: 'The report body.',
    surface: 'BACKLOG.md',
    date: '2026-08-03',
    chat: null,
    status: 'Todo',
    scope: [],
    under: null,
    supersedes: [],
    supersededBy: null,
    ...overrides,
  };
}

function filledIndex(entries: LedgerEntry[]): LedgerIndex {
  return {
    ...emptyIndex('backlog', '2026-08-03T00:00:00.000Z'),
    projects: [7],
    entries,
  };
}

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
  mkdirSync(dirname(path), { recursive: true });
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

describe('resolveEntries', () => {
  it('resolves an id found only in the index', () => {
    const index = filledIndex([ledgerEntry({ id: 'BACKLOG-only-index' })]);

    const resolved = resolveEntries(['BACKLOG-only-index'], [], index);

    expect(resolved.get('BACKLOG-only-index')?.title).toBe('Fix the thing');
  });

  it('resolves an id found only in the queue', () => {
    const queued = [
      ledgerEntry({ id: 'BACKLOG-only-queue', title: 'Queued only' }),
    ];

    const resolved = resolveEntries(['BACKLOG-only-queue'], queued, null);

    expect(resolved.get('BACKLOG-only-queue')?.title).toBe('Queued only');
  });

  it('takes the queue version when an id is in both', () => {
    const index = filledIndex([
      ledgerEntry({ id: 'BACKLOG-shared', title: 'Indexed title' }),
    ]);
    const queued = [
      ledgerEntry({ id: 'BACKLOG-shared', title: 'Freshly queued title' }),
    ];

    const resolved = resolveEntries(['BACKLOG-shared'], queued, index);

    expect(resolved.get('BACKLOG-shared')?.title).toBe('Freshly queued title');
  });

  it('leaves an unknown id out of the result', () => {
    const resolved = resolveEntries(['BACKLOG-nope'], [], filledIndex([]));

    expect(resolved.has('BACKLOG-nope')).toBe(false);
  });

  it('resolves only queued ids when the index is null', () => {
    const queued = [ledgerEntry({ id: 'BACKLOG-present', title: 'Present' })];

    const resolved = resolveEntries(
      ['BACKLOG-present', 'BACKLOG-absent'],
      queued,
      null,
    );

    expect(resolved.get('BACKLOG-present')?.title).toBe('Present');
    expect(resolved.has('BACKLOG-absent')).toBe(false);
  });
});

describe('capInjectedText', () => {
  it('returns text unchanged when under the cap', () => {
    expect(capInjectedText('short body', 100)).toBe('short body');
  });

  it('truncates to the cap and appends a notice when text exceeds it', () => {
    const result = capInjectedText('a'.repeat(500), 200);

    expect(result.length).toBe(200);
    expect(result).toContain('[houserules] truncated');
  });
});

describe('ledger-inject.mjs injected size cap', () => {
  it('caps stdout and signals elision when a matched body exceeds the shared budget', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    addBacklogEntry(root, 'TEST-0ff1ce', 'Huge entry', 'x'.repeat(20_000));

    const r = runScript(
      root,
      INJECT,
      promptInput('please look at TEST-0ff1ce'),
    );

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(MAX_INJECTED_CHARS);
    expect(r.stdout).toContain('[houserules] truncated');
  });
});

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

    it('injects a superseded decision, labeled superseded', () => {
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
  describe('a synced entry resolved from the local index', () => {
    it('injects an id that has left the queue and only lives in the index', () => {
      const root = useInstalledRepo('pnpm-monorepo');
      const dir = join(root, '.claude/ledgers');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'backlog.index.json'),
        serializeIndex(
          filledIndex([
            ledgerEntry({
              id: 'SIM-abcdef',
              title: 'Already on the board',
              body: 'synced body text',
              surface: 'BACKLOG.md',
            }),
          ]),
        ),
      );

      const r = runScript(
        root,
        INJECT,
        promptInput('what is SIM-abcdef about'),
      );

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/Already on the board/);
      expect(r.stdout).toMatch(/synced body text/);
    });

    it('exits 0 and prints nothing when the index file is corrupt', () => {
      const root = useInstalledRepo('pnpm-monorepo');
      const dir = join(root, '.claude/ledgers');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'backlog.index.json'), '{');

      const r = runScript(root, INJECT, promptInput('what about SIM-abcdef'));

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    it('still injects a queued entry when the index file is corrupt', () => {
      const root = useInstalledRepo('pnpm-monorepo');
      const dir = join(root, '.claude/ledgers');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'backlog.index.json'), '{');
      addBacklogEntry(
        root,
        'TEST-c0ffee',
        'Still works',
        'queue still injects',
      );

      const r = runScript(root, INJECT, promptInput('what about TEST-c0ffee'));

      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/Still works/);
    });
  });
});
