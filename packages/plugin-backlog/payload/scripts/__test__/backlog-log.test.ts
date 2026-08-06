import { beforeEach, describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';
import { editKitConfig } from '#test/installed-tree';

const LOG = '.claude/scripts/backlog-log.mjs';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const ROOT_SURFACE = '.claude/ledgers/BACKLOG.md';
const ROOT_RECORD_FILE = 'BACKLOG.md';

interface LogRecord {
  ts: string;
  id: string;
  action: string;
  file?: string;
  title?: string;
  reason?: string;
  chat: string | null;
  content?: string;
}

function stage(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'backlog/backlog',
    plugins: [{ name: PLUGIN_DIR, alias: 'backlog' }],
  });
}

function run(root: string, args: string[], input = '') {
  return runScript(root, LOG, { args, input });
}

function readFile(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function writeFile(root: string, rel: string, body: string) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

function logRecords(root: string): LogRecord[] {
  return readFile(root, '.claude/ledgers/backlog.jsonl')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogRecord);
}

function encodeBody(body: string): string {
  return gzipSync(Buffer.from(body, 'utf8')).toString('base64');
}

function decodeBody(encoded: string): string {
  return gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
}

function seedLog(root: string, records: Partial<LogRecord>[]) {
  writeFile(
    root,
    '.claude/ledgers/backlog.jsonl',
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
}

function backlogWith(entries: string[]): string {
  return `# Backlog — repo root\n\nDeferred work.\n\n${entries.join('')}`;
}

function entryOf(text: string, id: string): string {
  const start = text.indexOf(`## [${id}]`);
  const rest = text.slice(start);
  return rest.slice(0, rest.indexOf('\n---\n'));
}

function entryMarkdown(
  id: string,
  title: string,
  body: string,
  meta = '**Logged:** 2026-01-01',
): string {
  return `## [${id}] ${title}\n\n${meta}\n\n${body}\n\n---\n\n`;
}

describe('backlog-log.mjs add', () => {
  let root: string;

  beforeEach(() => {
    root = stage();
  });

  it('prints a PREFIX-6hex id built from the prefix', () => {
    const r = run(root, [
      'add',
      'TEST',
      'BACKLOG.md',
      'Cache the token',
      'memoize it',
      '--chat=none',
    ]);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toMatch(/^TEST-[0-9a-f]{6}$/);
  });

  it('creates the backlog file with a header naming the repo root', () => {
    run(root, ['add', 'TEST', 'BACKLOG.md', 'T', 'B', '--chat=none']);

    expect(readFile(root, ROOT_SURFACE)).toMatch(/^# Backlog — repo root\n/);
  });

  it('resolves the bare basename to the ledger directory, not the repo root', () => {
    run(root, ['add', 'TEST', 'BACKLOG.md', 'T', 'B', '--chat=none']);

    expect(existsSync(join(root, 'BACKLOG.md'))).toBe(false);
    expect(existsSync(join(root, ROOT_SURFACE))).toBe(true);
  });

  it('names the target by its label in the header of a per-area surface', () => {
    run(root, ['add', 'TEST', 'studio', 'T', 'B', '--chat=none']);

    expect(readFile(root, '.claude/ledgers/studio.BACKLOG.md')).toMatch(
      /^# Backlog — Studio\n/,
    );
  });

  it('renders the entry with its heading, logged date, body, and separator', () => {
    const id = run(root, [
      'add',
      'TEST',
      'BACKLOG.md',
      'Cache the token',
      'memoize it',
      '--chat=none',
    ]).stdout.trim();

    expect(readFile(root, ROOT_SURFACE)).toContain(
      `## [${id}] Cache the token\n\n**Logged:** ${new Date().toISOString().slice(0, 10)}\n\nmemoize it\n\n---\n`,
    );
  });

  it('appends a second entry without disturbing the first', () => {
    run(root, ['add', 'TEST', 'BACKLOG.md', 'First', 'one', '--chat=none']);
    run(root, ['add', 'TEST', 'BACKLOG.md', 'Second', 'two', '--chat=none']);

    const text = readFile(root, ROOT_SURFACE);
    expect(text.indexOf('First')).toBeLessThan(text.indexOf('Second'));
  });

  it('reads the body from stdin when no content argument is given', () => {
    run(
      root,
      ['add', 'TEST', 'BACKLOG.md', 'Piped', '--chat=none'],
      'via pipe',
    );

    expect(readFile(root, ROOT_SURFACE)).toContain('via pipe');
  });

  it('records an add event carrying the gzipped body', () => {
    const id = run(root, [
      'add',
      'TEST',
      'BACKLOG.md',
      'Cache the token',
      'memoize it',
      '--chat=none',
    ]).stdout.trim();

    const [record] = logRecords(root);
    expect(record).toMatchObject({
      id,
      action: 'add',
      file: ROOT_RECORD_FILE,
      title: 'Cache the token',
      chat: null,
    });
    expect(decodeBody(record.content!)).toBe('memoize it');
  });

  it('stamps the chat id given by --chat and echoes it', () => {
    const r = run(root, [
      'add',
      'TEST',
      'BACKLOG.md',
      'T',
      'B',
      '--chat',
      'session-77',
    ]);

    expect(r.stdout).toContain('chat: session-77');
    expect(logRecords(root)[0].chat).toBe('session-77');
    expect(readFile(root, ROOT_SURFACE)).toContain('**Chat:** session-77');
  });

  it('omits the chat line entirely when --chat=none', () => {
    run(root, ['add', 'TEST', 'BACKLOG.md', 'T', 'B', '--chat=none']);

    expect(readFile(root, ROOT_SURFACE)).not.toContain('**Chat:**');
  });

  it.each([
    { prefix: 'lower', reason: 'lowercase' },
    { prefix: 'Mixed', reason: 'mixed case' },
    { prefix: '1ST', reason: 'leading digit' },
    { prefix: 'WITH-DASH', reason: 'a dash' },
  ])('rejects a $reason prefix "$prefix"', ({ prefix }) => {
    const r = run(root, ['add', prefix, 'BACKLOG.md', 'T', 'B', '--chat=none']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`Invalid prefix "${prefix}"`);
  });

  it('rejects an empty body rather than logging a blank entry', () => {
    const r = run(root, ['add', 'TEST', 'BACKLOG.md', 'T', '', '--chat=none']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Empty body');
  });

  it('exits 1 with usage when the title is missing', () => {
    const r = run(root, ['add', 'TEST', 'BACKLOG.md', '--chat=none']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage:');
  });
});

describe('backlog-log.mjs remove', () => {
  let root: string;

  beforeEach(() => {
    root = stage();
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: ROOT_RECORD_FILE,
        title: 'First item',
        chat: null,
        content: encodeBody('body one'),
      },
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-bbbbbb',
        action: 'add',
        file: ROOT_RECORD_FILE,
        title: 'Second item',
        chat: null,
        content: encodeBody('body two'),
      },
    ]);
  });

  it('excises the named entry', () => {
    const r = run(root, [
      'remove',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'shipped it',
      '--chat=none',
    ]);

    expect(r.status, r.stderr).toBe(0);
    expect(readFile(root, ROOT_SURFACE)).not.toContain('TEST-aaaaaa');
  });

  it('leaves the sibling entry intact', () => {
    run(root, [
      'remove',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'shipped it',
      '--chat=none',
    ]);

    expect(readFile(root, ROOT_SURFACE)).toContain(
      '## [TEST-bbbbbb] Second item',
    );
  });

  it('takes the entry separator with it, leaving one for the surviving entry', () => {
    run(root, [
      'remove',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'shipped it',
      '--chat=none',
    ]);

    expect(readFile(root, ROOT_SURFACE).match(/\n---\n/g)).toHaveLength(1);
  });

  it('collapses the gap so no run of three newlines survives', () => {
    run(root, [
      'remove',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'shipped it',
      '--chat=none',
    ]);

    expect(readFile(root, ROOT_SURFACE)).not.toMatch(/\n{3,}/);
  });

  it('records a remove event carrying the reason and no body', () => {
    run(root, [
      'remove',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'shipped it',
      '--chat=none',
    ]);

    const record = logRecords(root)[2];
    expect(record).toMatchObject({
      id: 'TEST-aaaaaa',
      action: 'remove',
      file: ROOT_RECORD_FILE,
      reason: 'shipped it',
    });
    expect(record.content).toBeUndefined();
  });

  it('exits 1 when the id has no ledger record', () => {
    const r = run(root, [
      'remove',
      'TEST-cccccc',
      'BACKLOG.md',
      'nope',
      '--chat=none',
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no record of TEST-cccccc');
  });

  it('exits 1 with usage when the reason is missing', () => {
    const r = run(root, ['remove', 'TEST-aaaaaa', 'BACKLOG.md']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage:');
  });

  it('exits non-zero and leaves BACKLOG.md untouched when the id is only in the file, not the ledger', () => {
    writeFile(
      root,
      ROOT_SURFACE,
      backlogWith([
        entryMarkdown('TEST-cccccc', 'Untracked item', 'untracked body'),
      ]),
    );
    const before = readFile(root, ROOT_SURFACE);

    const r = run(root, [
      'remove',
      'TEST-cccccc',
      'BACKLOG.md',
      'nope',
      '--chat=none',
    ]);

    expect(r.status).not.toBe(0);
    expect(readFile(root, ROOT_SURFACE)).toBe(before);
  });
});

describe('backlog-log.mjs update', () => {
  let root: string;

  beforeEach(() => {
    root = stage();
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: ROOT_RECORD_FILE,
        title: 'Old title',
        chat: 'session-42',
        content: encodeBody('old body'),
      },
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-bbbbbb',
        action: 'add',
        file: ROOT_RECORD_FILE,
        title: 'Second item',
        chat: null,
        content: encodeBody('body two'),
      },
    ]);
  });

  it('replaces the title and body in place', () => {
    const r = run(root, [
      'update',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'New title',
      'new body',
      '--chat=none',
    ]);

    expect(r.status, r.stderr).toBe(0);
    expect(readFile(root, ROOT_SURFACE)).toContain(
      '## [TEST-aaaaaa] New title',
    );
    expect(readFile(root, ROOT_SURFACE)).not.toContain('old body');
  });

  it('preserves the original logged date rather than stamping today', () => {
    run(root, [
      'update',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'New title',
      'new body',
      '--chat=none',
    ]);

    expect(entryOf(readFile(root, ROOT_SURFACE), 'TEST-aaaaaa')).toContain(
      '**Logged:** 2026-01-01',
    );
  });

  it('preserves the chat id recorded when the entry was added', () => {
    run(root, [
      'update',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'New title',
      'new body',
      '--chat=none',
    ]);

    expect(entryOf(readFile(root, ROOT_SURFACE), 'TEST-aaaaaa')).toContain(
      '**Chat:** session-42',
    );
  });

  it('leaves the sibling entry intact', () => {
    run(root, [
      'update',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'New title',
      'new body',
      '--chat=none',
    ]);

    expect(readFile(root, ROOT_SURFACE)).toContain(
      '## [TEST-bbbbbb] Second item',
    );
  });

  it('records an update event carrying the new title and body', () => {
    run(root, [
      'update',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'New title',
      'new body',
      '--chat=none',
    ]);

    const record = logRecords(root)[2];
    expect(record).toMatchObject({
      id: 'TEST-aaaaaa',
      action: 'update',
      title: 'New title',
    });
    expect(decodeBody(record.content!)).toBe('new body');
  });

  it('exits 1 when the id has no ledger record', () => {
    const r = run(root, [
      'update',
      'TEST-cccccc',
      'BACKLOG.md',
      'T',
      'B',
      '--chat=none',
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no record of TEST-cccccc');
  });
});

describe('backlog-log.mjs move', () => {
  let root: string;

  beforeEach(() => {
    root = stage();
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: ROOT_RECORD_FILE,
        title: 'First item',
        chat: null,
        content: encodeBody('body one'),
      },
    ]);
  });

  it('renders the entry on the destination surface', () => {
    const r = run(root, ['move', 'TEST-aaaaaa', 'studio', '--chat=none']);

    expect(r.status, r.stderr).toBe(0);
    expect(readFile(root, '.claude/ledgers/studio.BACKLOG.md')).toContain(
      '## [TEST-aaaaaa] First item',
    );
  });

  it('does not rebuild a surface that only the move history still names', () => {
    run(root, ['move', 'TEST-aaaaaa', 'studio', '--chat=none']);
    rmSync(join(root, ROOT_SURFACE));

    run(root, ['render']);

    expect(existsSync(join(root, ROOT_SURFACE))).toBe(false);
  });

  it('removes the entry from the source surface', () => {
    run(root, ['move', 'TEST-aaaaaa', 'studio', '--chat=none']);

    expect(readFile(root, ROOT_SURFACE)).not.toContain('TEST-aaaaaa');
  });

  it('exits 1 when the id has no ledger record', () => {
    const r = run(root, ['move', 'TEST-cccccc', 'studio', '--chat=none']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no record of TEST-cccccc');
  });

  it('exits 0 when the source surface was already rendered to disk before the move', () => {
    run(root, ['render', 'BACKLOG.md']);

    const r = run(root, ['move', 'TEST-aaaaaa', 'studio', '--chat=none']);

    expect(r.status, r.stderr).toBe(0);
    expect(readFile(root, ROOT_SURFACE)).not.toContain('TEST-aaaaaa');
  });

  it('exits 1 when the id was already removed', () => {
    run(root, [
      'remove',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'shipped it',
      '--chat=none',
    ]);

    const r = run(root, ['move', 'TEST-aaaaaa', 'studio', '--chat=none']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no record of TEST-aaaaaa');
  });

  it('keeps the entry on its new surface after a later update', () => {
    run(root, ['move', 'TEST-aaaaaa', 'studio', '--chat=none']);

    run(root, [
      'update',
      'TEST-aaaaaa',
      'studio',
      'New title',
      'new body',
      '--chat=none',
    ]);

    expect(readFile(root, '.claude/ledgers/studio.BACKLOG.md')).toContain(
      '## [TEST-aaaaaa] New title',
    );
    expect(readFile(root, ROOT_SURFACE)).not.toContain('TEST-aaaaaa');
  });
});

describe('backlog-log.mjs show', () => {
  let root: string;

  beforeEach(() => {
    root = stage();
  });

  it('decodes the stored body for the requested id', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: 'BACKLOG.md',
        title: 'Cache the token',
        chat: 'session-42',
        content: encodeBody('memoize it'),
      },
    ]);

    const r = run(root, ['show', 'TEST-aaaaaa']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('memoize it');
    expect(r.stdout).toContain('chat: session-42');
  });

  it('prints every record for the id in log order', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        title: 'First',
        chat: null,
        content: encodeBody('one'),
      },
      {
        ts: '2026-01-02T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'update',
        title: 'Second',
        chat: null,
        content: encodeBody('two'),
      },
    ]);

    const r = run(root, ['show', 'TEST-aaaaaa']);

    expect(r.stdout.indexOf('one')).toBeLessThan(r.stdout.indexOf('two'));
  });

  it('prints the removal reason for a tombstoned entry', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'remove',
        reason: 'shipped it',
        chat: null,
      },
    ]);

    expect(run(root, ['show', 'TEST-aaaaaa']).stdout).toContain(
      'reason: shipped it',
    );
  });

  it('ignores records belonging to another id', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-bbbbbb',
        action: 'add',
        title: 'Other',
        chat: null,
        content: encodeBody('other body'),
      },
    ]);

    const r = run(root, ['show', 'TEST-aaaaaa']);

    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain('other body');
  });

  it('exits 1 when the id has no records', () => {
    seedLog(root, []);

    const r = run(root, ['show', 'TEST-aaaaaa']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('No log entries for TEST-aaaaaa');
  });

  it('exits 0 when no log exists yet, since an empty ledger is not an error', () => {
    const r = run(root, ['show', 'TEST-aaaaaa']);

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('No backlog log yet');
  });
});

describe('backlog-log.mjs list', () => {
  let root: string;

  beforeEach(() => {
    root = stage();
  });

  it('prints each entry as id, date, and title under its file path', () => {
    writeFile(
      root,
      ROOT_SURFACE,
      backlogWith([entryMarkdown('TEST-aaaaaa', 'First item', 'body one')]),
    );

    const r = run(root, ['list', 'BACKLOG.md']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`# ${ROOT_SURFACE}`);
    expect(r.stdout).toContain('TEST-aaaaaa  2026-01-01  First item');
  });

  it('discovers every surface in the ledger directory when no file is given', () => {
    writeFile(
      root,
      ROOT_SURFACE,
      backlogWith([entryMarkdown('ROOT-aaaaaa', 'Root item', 'body')]),
    );
    writeFile(
      root,
      '.claude/ledgers/studio.BACKLOG.md',
      backlogWith([entryMarkdown('STUDIO-bbbbbb', 'Studio item', 'body')]),
    );

    const r = run(root, ['list']);

    expect(r.stdout).toContain('ROOT-aaaaaa');
    expect(r.stdout).toContain('STUDIO-bbbbbb');
  });

  it('skips a backlog holding no entries', () => {
    writeFile(root, ROOT_SURFACE, backlogWith([]));

    expect(run(root, ['list']).stdout).not.toContain(`# ${ROOT_SURFACE}`);
  });

  it('reports a live entry from a migrated ledger with no rendered surface on disk', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: 'games/cityville/BACKLOG.md',
        title: 'Old-style item',
        chat: null,
        content: encodeBody('body'),
      },
    ]);

    const r = run(root, ['list']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('TEST-aaaaaa');
    expect(r.stdout).toContain('Old-style item');
  });
});

describe('backlog-log.mjs migrating a ledger written before the ledger-directory move', () => {
  it('still renders a record whose file field is the bare basename', () => {
    const root = stage();
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: ROOT_RECORD_FILE,
        title: 'Pre-move item',
        chat: null,
        content: encodeBody('body'),
      },
    ]);

    run(root, ['render', 'BACKLOG.md']);

    expect(readFile(root, ROOT_SURFACE)).toContain(
      '## [TEST-aaaaaa] Pre-move item',
    );
  });

  it('renders a record whose file field is a repo-relative target path at the target surface', () => {
    const root = stage();
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: 'games/cityville/BACKLOG.md',
        title: 'Old-style item',
        chat: null,
        content: encodeBody('body'),
      },
    ]);

    run(root, ['render', 'cityville']);

    expect(readFile(root, '.claude/ledgers/cityville.BACKLOG.md')).toContain(
      '## [TEST-aaaaaa] Old-style item',
    );
  });

  it('renders a mix of old-style and new-style entries for the same area together', () => {
    const root = stage();
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: 'games/cityville/BACKLOG.md',
        title: 'Old-style item',
        chat: null,
        content: encodeBody('body one'),
      },
      {
        ts: '2026-01-02T00:00:00.000Z',
        id: 'TEST-bbbbbb',
        action: 'add',
        file: 'cityville.BACKLOG.md',
        title: 'New-style item',
        chat: null,
        content: encodeBody('body two'),
      },
    ]);

    run(root, ['render', 'cityville']);

    const surface = readFile(root, '.claude/ledgers/cityville.BACKLOG.md');
    expect(surface).toContain('## [TEST-aaaaaa] Old-style item');
    expect(surface).toContain('## [TEST-bbbbbb] New-style item');
  });

  it('does not bleed an old-style entry from one target into a sibling target surface', () => {
    const root = stage();
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: 'games/cityville/BACKLOG.md',
        title: 'Cityville item',
        chat: null,
        content: encodeBody('body'),
      },
    ]);

    run(root, ['render', 'studio']);

    expect(readFile(root, '.claude/ledgers/studio.BACKLOG.md')).not.toContain(
      'Cityville item',
    );
  });

  it('falls back to the trailing directory name for an area the config no longer lists', () => {
    const root = stage();
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: 'packages/retired-area/BACKLOG.md',
        title: 'Orphaned item',
        chat: null,
        content: encodeBody('body'),
      },
    ]);

    run(root, ['render', 'retired-area']);

    expect(readFile(root, '.claude/ledgers/retired-area.BACKLOG.md')).toContain(
      '## [TEST-aaaaaa] Orphaned item',
    );
  });

  it('writes every surface the migrated ledger implies when render is given no argument', () => {
    const root = stage();
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: 'games/cityville/BACKLOG.md',
        title: 'Cityville item',
        chat: null,
        content: encodeBody('body one'),
      },
      {
        ts: '2026-01-02T00:00:00.000Z',
        id: 'TEST-bbbbbb',
        action: 'add',
        file: 'apps/studio/BACKLOG.md',
        title: 'Studio item',
        chat: null,
        content: encodeBody('body two'),
      },
    ]);

    const r = run(root, ['render']);

    expect(r.status, r.stderr).toBe(0);
    expect(readFile(root, '.claude/ledgers/cityville.BACKLOG.md')).toContain(
      '## [TEST-aaaaaa] Cityville item',
    );
    expect(readFile(root, '.claude/ledgers/studio.BACKLOG.md')).toContain(
      '## [TEST-bbbbbb] Studio item',
    );
  });
});

describe('backlog-log.mjs given an area named as a path rather than a bare word', () => {
  const AREA_SURFACE = '.claude/ledgers/studio.BACKLOG.md';
  const AREA_PATH = 'apps/studio/BACKLOG.md';
  let root: string;

  beforeEach(() => {
    root = stage();
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: 'studio.BACKLOG.md',
        title: 'First item',
        chat: null,
        content: encodeBody('body one'),
      },
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-bbbbbb',
        action: 'add',
        file: 'studio.BACKLOG.md',
        title: 'Second item',
        chat: null,
        content: encodeBody('body two'),
      },
    ]);
    run(root, ['render', 'studio']);
  });

  it('removes the entry from the canonical area surface', () => {
    const r = run(root, [
      'remove',
      'TEST-aaaaaa',
      AREA_PATH,
      'shipped it',
      '--chat=none',
    ]);

    expect(r.status, r.stderr).toBe(0);
    expect(readFile(root, AREA_SURFACE)).not.toContain('TEST-aaaaaa');
  });

  it('leaves the sibling entry on the canonical area surface', () => {
    run(root, [
      'remove',
      'TEST-aaaaaa',
      AREA_PATH,
      'shipped it',
      '--chat=none',
    ]);

    expect(readFile(root, AREA_SURFACE)).toContain(
      '## [TEST-bbbbbb] Second item',
    );
  });

  it('creates no surface at the path it was given', () => {
    run(root, [
      'remove',
      'TEST-aaaaaa',
      AREA_PATH,
      'shipped it',
      '--chat=none',
    ]);

    expect(existsSync(join(root, AREA_PATH))).toBe(false);
  });

  it('records the removal against the canonical area, not the path', () => {
    run(root, [
      'remove',
      'TEST-aaaaaa',
      AREA_PATH,
      'shipped it',
      '--chat=none',
    ]);

    expect(logRecords(root).at(-1)?.file).toBe('studio.BACKLOG.md');
  });

  it('adds to the same surface the bare area name writes', () => {
    const id = run(root, [
      'add',
      'TEST',
      AREA_PATH,
      'Third item',
      'body three',
      '--chat=none',
    ]).stdout.trim();

    expect(readFile(root, AREA_SURFACE)).toContain(id);
  });

  it('honors a path that names no surface as a literal write target', () => {
    mkdirSync(join(root, 'docs'), { recursive: true });

    run(root, [
      'add',
      'TEST',
      'docs/deferred.md',
      'Loose item',
      'body',
      '--chat=none',
    ]);

    expect(existsSync(join(root, 'docs/deferred.md'))).toBe(true);
  });
});

describe('backlog-log.mjs given an area named by its own surface filename', () => {
  const AREA_SURFACE = '.claude/ledgers/studio.BACKLOG.md';
  const DOUBLED = '.claude/ledgers/studio.BACKLOG.md.BACKLOG.md';
  let root: string;

  beforeEach(() => {
    root = stage();
  });

  it('records the entry on the area surface', () => {
    const id = run(root, [
      'add',
      'TEST',
      'studio.BACKLOG.md',
      'An item',
      'body',
      '--chat=none',
    ]).stdout.trim();

    expect(readFile(root, AREA_SURFACE)).toContain(id);
  });

  it('creates no surface carrying the basename twice', () => {
    run(root, [
      'add',
      'TEST',
      'studio.BACKLOG.md',
      'An item',
      'body',
      '--chat=none',
    ]);

    expect(existsSync(join(root, DOUBLED))).toBe(false);
  });

  it('renders a record already stamped with a doubled name onto the area surface', () => {
    seedLog(root, [
      {
        ts: '2026-01-01T00:00:00.000Z',
        id: 'TEST-aaaaaa',
        action: 'add',
        file: 'studio.BACKLOG.md.BACKLOG.md',
        title: 'Doubled item',
        chat: null,
        content: encodeBody('body'),
      },
    ]);

    run(root, ['render']);

    expect(readFile(root, AREA_SURFACE)).toContain(
      '## [TEST-aaaaaa] Doubled item',
    );
  });
});

describe('backlog-log.mjs with a configured ledgers.dir', () => {
  it('writes the ledger and the area surface under the configured directory', () => {
    const root = stage();
    editKitConfig(root, (config) => {
      config.ledgers = { dir: '.claude/state/ledgers' };
    });

    const id = run(root, [
      'add',
      'TEST',
      'studio',
      'T',
      'B',
      '--chat=none',
    ]).stdout.trim();

    expect(readFile(root, '.claude/state/ledgers/backlog.jsonl')).toContain(id);
    expect(readFile(root, '.claude/state/ledgers/studio.BACKLOG.md')).toContain(
      id,
    );
  });
});

describe('backlog-log.mjs with no recognized action', () => {
  let root: string;

  beforeEach(() => {
    root = stage();
  });

  it('exits 1 on an unknown action', () => {
    const r = run(root, ['frobnicate']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage:');
  });

  it('exits 0 when invoked with no arguments at all', () => {
    expect(run(root, []).status).toBe(0);
  });
});
