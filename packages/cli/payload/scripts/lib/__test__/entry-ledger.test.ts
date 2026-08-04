import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decodeBody,
  encodeBody,
  findSurfaceFiles,
  ledgerDir,
  ledgerPath,
  parseEntries,
  readLog,
  rebuildWouldDropEntries,
  renderMetadata,
  resolveSurfaceArg,
  surfacePath,
  surfaceRelFile,
  surfaceScope,
  resolveChat,
  takeChatFlag,
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
  it('finds the root surface and every per-area surface in the ledger directory', () => {
    const root = tempRoot();
    writeAt(root, 'ledgers/BACKLOG.md', '');
    writeAt(root, 'ledgers/studio.BACKLOG.md', '');

    expect(findSurfaceFiles(join(root, 'ledgers'), 'BACKLOG.md')).toHaveLength(
      2,
    );
  });

  it('ignores a file with a different basename', () => {
    const root = tempRoot();
    writeAt(root, 'ledgers/DECISIONS.md', '');

    expect(findSurfaceFiles(join(root, 'ledgers'), 'BACKLOG.md')).toEqual([]);
  });

  it('ignores the ledger itself rather than treating it as a surface', () => {
    const root = tempRoot();
    writeAt(root, 'ledgers/backlog.jsonl', '');

    expect(findSurfaceFiles(join(root, 'ledgers'), 'BACKLOG.md')).toEqual([]);
  });

  it('returns nothing when the ledger directory does not exist', () => {
    expect(findSurfaceFiles(join(tempRoot(), 'absent'), 'BACKLOG.md')).toEqual(
      [],
    );
  });
});

describe('ledgerDir', () => {
  it('defaults to .claude/ledgers', () => {
    const root = tempRoot();

    expect(ledgerDir(root)).toBe(join(root, '.claude/ledgers'));
  });

  it('honours a configured directory', () => {
    const root = tempRoot();

    expect(ledgerDir(root, 'docs/ledgers')).toBe(join(root, 'docs/ledgers'));
  });

  it('falls back to the default when the configured path escapes the repo', () => {
    const root = tempRoot();

    expect(ledgerDir(root, '../outside')).toBe(join(root, '.claude/ledgers'));
  });

  it('refuses the repo root, where the self-ignore rule would hide every document', () => {
    const root = tempRoot();

    expect(ledgerDir(root, '.')).toBe(join(root, '.claude/ledgers'));
  });
});

describe('surfacePath', () => {
  it('leaves the root surface unprefixed', () => {
    expect(surfacePath('/l', 'BACKLOG.md')).toBe('/l/BACKLOG.md');
  });

  it('prefixes a per-area surface with the target name', () => {
    expect(surfacePath('/l', 'BACKLOG.md', 'studio')).toBe(
      '/l/studio.BACKLOG.md',
    );
  });
});

describe('surfaceScope', () => {
  it('names the repo root for an unprefixed surface', () => {
    expect(surfaceScope('/l/BACKLOG.md', 'BACKLOG.md', [])).toBe('repo root');
  });

  it('maps a target name to its path prefix', () => {
    expect(
      surfaceScope('/l/studio.BACKLOG.md', 'BACKLOG.md', [
        { name: 'studio', pathPrefix: 'apps/studio/' },
      ]),
    ).toBe('apps/studio');
  });

  it('falls back to the target name when no target matches', () => {
    expect(surfaceScope('/l/studio.BACKLOG.md', 'BACKLOG.md', [])).toBe(
      'studio',
    );
  });
});

describe('resolveSurfaceArg', () => {
  it('resolves an omitted argument to the root surface in the ledger directory', () => {
    expect(
      resolveSurfaceArg('/repo', '/repo/.claude/ledgers', 'BACKLOG.md'),
    ).toBe('/repo/.claude/ledgers/BACKLOG.md');
  });

  it('resolves the bare basename to the ledger directory rather than the repo root', () => {
    expect(
      resolveSurfaceArg(
        '/repo',
        '/repo/.claude/ledgers',
        'BACKLOG.md',
        'BACKLOG.md',
      ),
    ).toBe('/repo/.claude/ledgers/BACKLOG.md');
  });

  it('treats a bare word as an area name', () => {
    expect(
      resolveSurfaceArg(
        '/repo',
        '/repo/.claude/ledgers',
        'BACKLOG.md',
        'studio',
      ),
    ).toBe('/repo/.claude/ledgers/studio.BACKLOG.md');
  });

  it('resolves an explicit path against the repo root, not the process cwd', () => {
    expect(
      resolveSurfaceArg(
        '/repo',
        '/repo/.claude/ledgers',
        'BACKLOG.md',
        'docs/BACKLOG.md',
      ),
    ).toBe('/repo/docs/BACKLOG.md');
  });
});

describe('surfaceRelFile', () => {
  it('records the root surface as a bare basename, matching records written before the move', () => {
    expect(
      surfaceRelFile(
        '/repo/.claude/ledgers',
        '/repo/.claude/ledgers/BACKLOG.md',
      ),
    ).toBe('BACKLOG.md');
  });

  it('records an area surface by its prefixed filename', () => {
    expect(
      surfaceRelFile(
        '/repo/.claude/ledgers',
        '/repo/.claude/ledgers/studio.BACKLOG.md',
      ),
    ).toBe('studio.BACKLOG.md');
  });

  it('stays stable when the ledger directory is configured elsewhere', () => {
    expect(
      surfaceRelFile('/repo/docs/ledgers', '/repo/docs/ledgers/BACKLOG.md'),
    ).toBe('BACKLOG.md');
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

function entriesOf(count: number): string {
  let text = '';
  for (let i = 0; i < count; i++) {
    text += `## [SIM-aaaaa${i}] Entry ${i}\n\nbody ${i}\n\n---\n\n`;
  }
  return text;
}

describe('ledgerPath', () => {
  it('returns the ledgers path when no ledger exists anywhere', () => {
    const root = tempRoot();

    const result = ledgerPath(root, 'decision-log');

    expect(result).toBe(join(root, '.claude/ledgers/decision-log.jsonl'));
  });

  it('returns the ledgers path and leaves it alone when it already exists', () => {
    const root = tempRoot();
    writeAt(root, '.claude/ledgers/decision-log.jsonl', '{"id":"A"}\n');

    const result = ledgerPath(root, 'decision-log');

    expect(result).toBe(join(root, '.claude/ledgers/decision-log.jsonl'));
    expect(readFileSync(result, 'utf8')).toBe('{"id":"A"}\n');
  });

  it('migrates a legacy .log and preserves its exact byte content', () => {
    const root = tempRoot();
    const legacyBody = '{"id":"A"}\n{"id":"B"}\n';
    writeAt(root, '.claude/decision-log.log', legacyBody);

    const result = ledgerPath(root, 'decision-log');

    expect(result).toBe(join(root, '.claude/ledgers/decision-log.jsonl'));
    expect(readFileSync(result, 'utf8')).toBe(legacyBody);
    expect(existsSync(join(root, '.claude/decision-log.log'))).toBe(false);
  });

  it('migrates a flat .jsonl left by the previous layout', () => {
    const root = tempRoot();
    writeAt(root, '.claude/decision-log.jsonl', '{"id":"A"}\n');

    const result = ledgerPath(root, 'decision-log');

    expect(result).toBe(join(root, '.claude/ledgers/decision-log.jsonl'));
    expect(readFileSync(result, 'utf8')).toBe('{"id":"A"}\n');
    expect(existsSync(join(root, '.claude/decision-log.jsonl'))).toBe(false);
  });

  it('prefers the newest layout and leaves older files untouched', () => {
    const root = tempRoot();
    writeAt(root, '.claude/ledgers/decision-log.jsonl', '{"id":"current"}\n');
    writeAt(root, '.claude/decision-log.jsonl', '{"id":"flat"}\n');
    writeAt(root, '.claude/decision-log.log', '{"id":"legacy"}\n');

    const result = ledgerPath(root, 'decision-log');

    expect(readFileSync(result, 'utf8')).toBe('{"id":"current"}\n');
    expect(existsSync(join(root, '.claude/decision-log.jsonl'))).toBe(true);
    expect(existsSync(join(root, '.claude/decision-log.log'))).toBe(true);
  });
});

describe('rebuildWouldDropEntries', () => {
  it('returns false when the file does not exist', () => {
    const root = tempRoot();

    expect(
      rebuildWouldDropEntries(join(root, 'DECISIONS.md'), entriesOf(1)),
    ).toBe(false);
  });

  it('returns false when the file has no entries', () => {
    const root = tempRoot();
    const file = writeAt(
      root,
      'DECISIONS.md',
      '# Decisions\n\nno entries yet\n',
    );

    expect(rebuildWouldDropEntries(file, entriesOf(1))).toBe(false);
  });

  it('returns true when a four-entry file is replaced by one-entry content', () => {
    const root = tempRoot();
    const file = writeAt(root, 'DECISIONS.md', entriesOf(4));

    expect(rebuildWouldDropEntries(file, entriesOf(1))).toBe(true);
  });

  it('returns false when the only missing entry is one the ledger recorded as removed', () => {
    const root = tempRoot();
    const file = writeAt(root, 'BACKLOG.md', entriesOf(3));

    expect(
      rebuildWouldDropEntries(file, entriesOf(2), new Set(['SIM-aaaaa2'])),
    ).toBe(false);
  });

  it('returns true when an entry vanishes that the ledger did not record as removed', () => {
    const root = tempRoot();
    const file = writeAt(root, 'BACKLOG.md', entriesOf(3));

    expect(
      rebuildWouldDropEntries(file, entriesOf(2), new Set(['SIM-aaaaa9'])),
    ).toBe(true);
  });

  it('returns true when one entry is swapped for another and the count is unchanged', () => {
    const root = tempRoot();
    const file = writeAt(root, 'BACKLOG.md', entriesOf(2));
    const swapped = `${entriesOf(1)}## [SIM-bbbbb0] Other\n\nbody\n\n---\n\n`;

    expect(rebuildWouldDropEntries(file, swapped)).toBe(true);
  });

  it('returns false when the replacement has the same entry count', () => {
    const root = tempRoot();
    const file = writeAt(root, 'DECISIONS.md', entriesOf(3));

    expect(rebuildWouldDropEntries(file, entriesOf(3))).toBe(false);
  });

  it('returns false when the replacement has more entries', () => {
    const root = tempRoot();
    const file = writeAt(root, 'DECISIONS.md', entriesOf(2));

    expect(rebuildWouldDropEntries(file, entriesOf(3))).toBe(false);
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
