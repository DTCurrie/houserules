import { beforeEach, describe, expect, it } from 'vitest';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const LOG = '.claude/scripts/backlog-log.mjs';

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
  return readFile(root, '.claude/backlog.log')
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
    '.claude/backlog.log',
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
    root = useInstalledRepo('pnpm-monorepo');
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

    expect(readFile(root, 'BACKLOG.md')).toMatch(/^# Backlog — repo root\n/);
  });

  it('names the containing directory in the header of a nested backlog', () => {
    run(root, [
      'add',
      'TEST',
      'apps/studio/BACKLOG.md',
      'T',
      'B',
      '--chat=none',
    ]);

    expect(readFile(root, 'apps/studio/BACKLOG.md')).toMatch(
      /^# Backlog — apps\/studio\n/,
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

    expect(readFile(root, 'BACKLOG.md')).toContain(
      `## [${id}] Cache the token\n\n**Logged:** ${new Date().toISOString().slice(0, 10)}\n\nmemoize it\n\n---\n`,
    );
  });

  it('appends a second entry without disturbing the first', () => {
    run(root, ['add', 'TEST', 'BACKLOG.md', 'First', 'one', '--chat=none']);
    run(root, ['add', 'TEST', 'BACKLOG.md', 'Second', 'two', '--chat=none']);

    const text = readFile(root, 'BACKLOG.md');
    expect(text.indexOf('First')).toBeLessThan(text.indexOf('Second'));
  });

  it('reads the body from stdin when no content argument is given', () => {
    run(
      root,
      ['add', 'TEST', 'BACKLOG.md', 'Piped', '--chat=none'],
      'via pipe',
    );

    expect(readFile(root, 'BACKLOG.md')).toContain('via pipe');
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
      file: 'BACKLOG.md',
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
    expect(readFile(root, 'BACKLOG.md')).toContain('**Chat:** session-77');
  });

  it('omits the chat line entirely when --chat=none', () => {
    run(root, ['add', 'TEST', 'BACKLOG.md', 'T', 'B', '--chat=none']);

    expect(readFile(root, 'BACKLOG.md')).not.toContain('**Chat:**');
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
    root = useInstalledRepo('pnpm-monorepo');
    writeFile(
      root,
      'BACKLOG.md',
      backlogWith([
        entryMarkdown('TEST-aaaaaa', 'First item', 'body one'),
        entryMarkdown('TEST-bbbbbb', 'Second item', 'body two'),
      ]),
    );
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
    expect(readFile(root, 'BACKLOG.md')).not.toContain('TEST-aaaaaa');
  });

  it('leaves the sibling entry intact', () => {
    run(root, [
      'remove',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'shipped it',
      '--chat=none',
    ]);

    expect(readFile(root, 'BACKLOG.md')).toContain(
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

    expect(readFile(root, 'BACKLOG.md').match(/\n---\n/g)).toHaveLength(1);
  });

  it('collapses the gap so no run of three newlines survives', () => {
    run(root, [
      'remove',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'shipped it',
      '--chat=none',
    ]);

    expect(readFile(root, 'BACKLOG.md')).not.toMatch(/\n{3,}/);
  });

  it('records a remove event carrying the reason and no body', () => {
    run(root, [
      'remove',
      'TEST-aaaaaa',
      'BACKLOG.md',
      'shipped it',
      '--chat=none',
    ]);

    const [record] = logRecords(root);
    expect(record).toMatchObject({
      id: 'TEST-aaaaaa',
      action: 'remove',
      file: 'BACKLOG.md',
      reason: 'shipped it',
    });
    expect(record.content).toBeUndefined();
  });

  it('exits 1 when the id is not in the file', () => {
    const r = run(root, [
      'remove',
      'TEST-cccccc',
      'BACKLOG.md',
      'nope',
      '--chat=none',
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TEST-cccccc not found');
  });

  it('exits 1 with usage when the reason is missing', () => {
    const r = run(root, ['remove', 'TEST-aaaaaa', 'BACKLOG.md']);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage:');
  });
});

describe('backlog-log.mjs update', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    writeFile(
      root,
      'BACKLOG.md',
      backlogWith([
        entryMarkdown(
          'TEST-aaaaaa',
          'Old title',
          'old body',
          '**Logged:** 2026-01-01\n**Chat:** session-42',
        ),
        entryMarkdown('TEST-bbbbbb', 'Second item', 'body two'),
      ]),
    );
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
    expect(readFile(root, 'BACKLOG.md')).toContain(
      '## [TEST-aaaaaa] New title',
    );
    expect(readFile(root, 'BACKLOG.md')).not.toContain('old body');
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

    expect(entryOf(readFile(root, 'BACKLOG.md'), 'TEST-aaaaaa')).toContain(
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

    expect(entryOf(readFile(root, 'BACKLOG.md'), 'TEST-aaaaaa')).toContain(
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

    expect(readFile(root, 'BACKLOG.md')).toContain(
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

    const [record] = logRecords(root);
    expect(record).toMatchObject({
      id: 'TEST-aaaaaa',
      action: 'update',
      title: 'New title',
    });
    expect(decodeBody(record.content!)).toBe('new body');
  });

  it('exits 1 when the id is not in the file', () => {
    const r = run(root, [
      'update',
      'TEST-cccccc',
      'BACKLOG.md',
      'T',
      'B',
      '--chat=none',
    ]);

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('TEST-cccccc not found');
  });
});

describe('backlog-log.mjs show', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
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
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('prints each entry as id, date, and title under its file path', () => {
    writeFile(
      root,
      'BACKLOG.md',
      backlogWith([entryMarkdown('TEST-aaaaaa', 'First item', 'body one')]),
    );

    const r = run(root, ['list', 'BACKLOG.md']);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('# BACKLOG.md');
    expect(r.stdout).toContain('TEST-aaaaaa  2026-01-01  First item');
  });

  it('walks the tree for every backlog when no file is given', () => {
    writeFile(
      root,
      'BACKLOG.md',
      backlogWith([entryMarkdown('ROOT-aaaaaa', 'Root item', 'body')]),
    );
    writeFile(
      root,
      'apps/studio/BACKLOG.md',
      backlogWith([entryMarkdown('STUDIO-bbbbbb', 'Studio item', 'body')]),
    );

    const r = run(root, ['list']);

    expect(r.stdout).toContain('ROOT-aaaaaa');
    expect(r.stdout).toContain('STUDIO-bbbbbb');
  });

  it('skips a backlog holding no entries', () => {
    writeFile(root, 'BACKLOG.md', backlogWith([]));

    expect(run(root, ['list']).stdout).not.toContain('# BACKLOG.md');
  });
});

describe('backlog-log.mjs with no recognized action', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
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
