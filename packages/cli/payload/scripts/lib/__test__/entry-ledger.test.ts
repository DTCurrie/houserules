import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decodeBody,
  encodeBody,
  findEntryRange,
  findSurfaceFiles,
  parseEntries,
  readLog,
  renderMetadata,
  resolveChat,
  takeChatFlag,
  tidySurface,
} from '../../../../payload-dist/scripts/lib/entry-ledger.mjs';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'entry-ledger-'));
  roots.push(root);
  return root;
}

function writeAt(root: string, rel: string, body: string) {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  return full;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('parseEntries', () => {
  it('returns the id, title, and body of an entry', () => {
    const [entry] = parseEntries(
      '## [SIM-aaaaaa] A title\n\nthe body\n\n---\n',
    );

    expect(entry).toMatchObject({
      id: 'SIM-aaaaaa',
      title: 'A title',
      body: 'the body',
    });
  });

  it('lifts a metadata line out of the body and into meta', () => {
    const [entry] = parseEntries(
      '## [SIM-aaaaaa] T\n\n**Logged:** 2026-01-01\n\nthe body\n\n---\n',
    );

    expect(entry.meta).toEqual({ Logged: '2026-01-01' });
    expect(entry.body).toBe('the body');
  });

  it('reads several labels joined by a middot on one line', () => {
    const [entry] = parseEntries(
      '## [SIM-aaaaaa] T\n\n**Decided:** 2026-07-14 · **Status:** accepted\n\nbody\n\n---\n',
    );

    expect(entry.meta).toEqual({
      Decided: '2026-07-14',
      Status: 'accepted',
    });
  });

  it('keeps the first value when a label repeats', () => {
    const [entry] = parseEntries(
      '## [SIM-aaaaaa] T\n\n**Logged:** 2026-01-01\n**Logged:** 2026-09-09\n\nbody\n\n---\n',
    );

    expect(entry.meta.Logged).toBe('2026-01-01');
  });

  it('leaves a repeated label line in the body rather than dropping it', () => {
    const [entry] = parseEntries(
      '## [SIM-aaaaaa] T\n\n**Logged:** 2026-01-01\n**Logged:** 2026-09-09\n\nbody\n\n---\n',
    );

    expect(entry.body).toContain('**Logged:** 2026-09-09');
  });

  it('ends an entry at the separator', () => {
    const entries = parseEntries(
      '## [SIM-aaaaaa] First\n\none\n\n---\n\n## [SIM-bbbbbb] Second\n\ntwo\n\n---\n',
    );

    expect(entries).toHaveLength(2);
    expect(entries[0].body).toBe('one');
  });

  it('ignores prose before the first entry heading', () => {
    const entries = parseEntries(
      '# Backlog\n\nsome preamble\n\n## [SIM-aaaaaa] T\n\nbody\n\n---\n',
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe('body');
  });
});

describe('findEntryRange', () => {
  const surface =
    '# Head\n\n## [SIM-aaaaaa] First\n\n**Logged:** 2026-01-01\n\none\n\n---\n\n## [SIM-bbbbbb] Second\n\ntwo\n\n---\n';

  it('returns null when the id is absent', () => {
    expect(findEntryRange(surface, 'SIM-zzzzzz')).toBeNull();
  });

  it('collects the header metadata of the matched entry', () => {
    expect(findEntryRange(surface, 'SIM-aaaaaa')!.meta).toEqual({
      Logged: '2026-01-01',
    });
  });

  it('spans through the separator so removing an entry takes it too', () => {
    const range = findEntryRange(surface, 'SIM-aaaaaa')!;

    expect(range.lines.slice(range.start, range.end)).toContain('---');
  });

  it('stops before the next entry heading', () => {
    const range = findEntryRange(surface, 'SIM-aaaaaa')!;

    expect(range.lines.slice(range.start, range.end).join('\n')).not.toContain(
      'SIM-bbbbbb',
    );
  });

  it('keeps the last value when a label repeats inside the header window', () => {
    const repeated =
      '## [SIM-aaaaaa] T\n**Logged:** 2026-01-01\n**Logged:** 2026-09-09\n\nbody\n\n---\n';

    expect(findEntryRange(repeated, 'SIM-aaaaaa')!.meta.Logged).toBe(
      '2026-09-09',
    );
  });

  it('ignores a metadata line past the eight-line header window', () => {
    const late = `## [SIM-aaaaaa] T\n${'filler\n'.repeat(7)}**Late:** value\n\n---\n`;

    expect(findEntryRange(late, 'SIM-aaaaaa')!.meta.Late).toBeUndefined();
  });
});

describe('renderMetadata', () => {
  it('renders one bolded label per line', () => {
    expect(renderMetadata({ Logged: '2026-01-01', Chat: 'abc' })).toBe(
      '**Logged:** 2026-01-01\n**Chat:** abc',
    );
  });

  it('drops a field whose value is null', () => {
    expect(renderMetadata({ Logged: '2026-01-01', Chat: null })).toBe(
      '**Logged:** 2026-01-01',
    );
  });

  it('round-trips through parseEntries', () => {
    const meta = renderMetadata({ Decided: '2026-07-14', Status: 'accepted' });

    const [entry] = parseEntries(
      `## [SIM-aaaaaa] T\n\n${meta}\n\nbody\n\n---\n`,
    );

    expect(entry.meta).toEqual({ Decided: '2026-07-14', Status: 'accepted' });
  });
});

describe('readLog', () => {
  it('returns nothing when the log does not exist', () => {
    expect(readLog(join(tempRoot(), 'absent.log'))).toEqual([]);
  });

  it('parses one record per line', () => {
    const root = tempRoot();
    const log = writeAt(root, 'a.log', '{"id":"A"}\n{"id":"B"}\n');

    expect(readLog(log)).toEqual([{ id: 'A' }, { id: 'B' }]);
  });

  it('skips an unparseable line rather than blinding the whole ledger', () => {
    const root = tempRoot();
    const log = writeAt(root, 'a.log', '{"id":"A"}\nnot json\n{"id":"B"}\n');

    expect(readLog(log)).toEqual([{ id: 'A' }, { id: 'B' }]);
  });
});

describe('findSurfaceFiles', () => {
  it('finds the file at the root and in nested directories', () => {
    const root = tempRoot();
    writeAt(root, 'BACKLOG.md', '');
    writeAt(root, 'apps/studio/BACKLOG.md', '');

    expect(findSurfaceFiles(root, 'BACKLOG.md')).toHaveLength(2);
  });

  it('does not descend into node_modules', () => {
    const root = tempRoot();
    writeAt(root, 'node_modules/pkg/BACKLOG.md', '');

    expect(findSurfaceFiles(root, 'BACKLOG.md')).toEqual([]);
  });

  it('ignores a file with a different basename', () => {
    const root = tempRoot();
    writeAt(root, 'DECISIONS.md', '');

    expect(findSurfaceFiles(root, 'BACKLOG.md')).toEqual([]);
  });
});

describe('tidySurface', () => {
  it('collapses a run of blank lines left by a splice', () => {
    expect(tidySurface('a\n\n\n\nb\n')).toBe('a\n\nb\n');
  });

  it('ends the file with exactly one newline', () => {
    expect(tidySurface('a\n\n\n')).toBe('a\n');
  });
});

describe('takeChatFlag', () => {
  it('splices a separated --chat and its value out of argv', () => {
    const argv = ['add', '--chat', 'session-7', 'TITLE'];

    expect(takeChatFlag(argv)).toBe('session-7');
    expect(argv).toEqual(['add', 'TITLE']);
  });

  it('splices a joined --chat= out of argv', () => {
    const argv = ['add', '--chat=session-7', 'TITLE'];

    expect(takeChatFlag(argv)).toBe('session-7');
    expect(argv).toEqual(['add', 'TITLE']);
  });

  it('returns null and leaves argv alone when the flag is absent', () => {
    const argv = ['add', 'TITLE'];

    expect(takeChatFlag(argv)).toBeNull();
    expect(argv).toEqual(['add', 'TITLE']);
  });
});

describe('resolveChat', () => {
  it('suppresses provenance for the sentinel "none"', () => {
    expect(resolveChat('none', tempRoot())).toBeNull();
  });

  it('takes an explicit id over anything detected', () => {
    expect(resolveChat('session-7', tempRoot())).toBe('session-7');
  });
});

describe('encodeBody', () => {
  it('round-trips a body through decodeBody', () => {
    expect(decodeBody(encodeBody('a body · with punctuation'))).toBe(
      'a body · with punctuation',
    );
  });

  it('encodes an absent body as the empty string', () => {
    expect(decodeBody(encodeBody(undefined))).toBe('');
  });
});
