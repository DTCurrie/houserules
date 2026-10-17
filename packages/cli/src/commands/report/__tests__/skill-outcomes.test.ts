import { describe, expect, it, onTestFinished } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptyIndex, serializeIndex } from '@houserules/payload/ledger-index';
import type { LedgerEntry } from '@houserules/payload/ledger-index';
import { useRepo } from '#test/repo';
import { runIn } from '#test/run';

import { emptyCorpus, ingestTranscript } from '../transcript-events.js';
import type { Corpus } from '../transcript-events.js';
import {
  computeChangesetOutcome,
  computeLedgerOutcome,
  renderSkillOutcomes,
} from '../skill-outcomes.js';

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kit-skill-outcomes-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
}

function skillFireLine(sessionId: string, ts: string, skill: string): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId,
    timestamp: ts,
    message: {
      content: [
        {
          type: 'tool_use',
          id: `${sessionId}-${skill}`,
          name: 'Skill',
          input: { skill },
        },
      ],
    },
  });
}

function commandFireLine(sessionId: string, ts: string, skill: string): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    timestamp: ts,
    uuid: `${sessionId}-${skill}-cmd`,
    message: { content: `<command-name>/${skill}</command-name>` },
  });
}

function corpusFromLines(lines: string[]): Corpus {
  const corpus = emptyCorpus(['slug']);
  ingestTranscript(corpus, 'session.jsonl', lines.join('\n'));
  return corpus;
}

describe('computeChangesetOutcome', () => {
  it('matches a fire against a changeset record entry with the same chat id', () => {
    const root = tempRoot();
    writeFile(
      root,
      '.claude/state/changesets.jsonl',
      `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', chat: 'sess-1' })}\n`,
    );
    const corpus = corpusFromLines([
      skillFireLine('sess-1', '2026-01-01T00:05:00.000Z', 'changeset'),
    ]);

    const outcome = computeChangesetOutcome(corpus, root);

    expect(outcome).toEqual({
      fires: 1,
      exact: 1,
      windowed: 0,
      recordEntries: 1,
      filesAdded: 0,
    });
  });

  it('matches a fire against a record entry with no chat id via the 30-minute ts window', () => {
    const root = tempRoot();
    writeFile(
      root,
      '.claude/state/changesets.jsonl',
      `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z' })}\n`,
    );
    const corpus = corpusFromLines([
      commandFireLine('sess-2', '2026-01-01T00:10:00.000Z', 'changeset'),
    ]);

    const outcome = computeChangesetOutcome(corpus, root);

    expect(outcome).toEqual({
      fires: 1,
      exact: 1,
      windowed: 0,
      recordEntries: 1,
      filesAdded: 0,
    });
  });

  it('consumes each record entry at most once across two fires from the same session', () => {
    const root = tempRoot();
    writeFile(
      root,
      '.claude/state/changesets.jsonl',
      `${JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', chat: 'sess-3' })}\n`,
    );
    const corpus = corpusFromLines([
      skillFireLine('sess-3', '2026-01-01T00:01:00.000Z', 'changeset'),
      skillFireLine('sess-3', '2026-01-01T00:02:00.000Z', 'changeset'),
    ]);

    const outcome = computeChangesetOutcome(corpus, root);

    expect(outcome).toEqual({
      fires: 2,
      exact: 1,
      windowed: 0,
      recordEntries: 1,
      filesAdded: 0,
    });
  });

  it('falls back to a git-added .changeset file within the 72h window when no record matches', () => {
    const root = useRepo('non-js');
    mkdirSync(join(root, '.changeset'), { recursive: true });
    writeFileSync(
      join(root, '.changeset', 'fancy-name.md'),
      '---\n"@fancy/pkg": patch\n---\n\nFancy change.\n',
    );
    runIn(root, 'git', ['add', '.changeset/fancy-name.md']);
    runIn(root, 'git', ['commit', '-qm', 'add changeset']);
    const commitEpochSeconds = Number(
      runIn(root, 'git', ['log', '-1', '--format=%ct']).trim(),
    );
    const fireTs = commitEpochSeconds * 1000 - 60_000;
    const corpus = corpusFromLines([
      skillFireLine('sess-4', new Date(fireTs).toISOString(), 'changeset'),
    ]);

    const outcome = computeChangesetOutcome(corpus, root);

    expect(outcome).toEqual({
      fires: 1,
      exact: 0,
      windowed: 1,
      recordEntries: 0,
      filesAdded: 1,
    });
  });

  it('leaves a fire unmatched when neither the record nor git history covers it', () => {
    const root = useRepo('non-js');
    const corpus = corpusFromLines([
      skillFireLine('sess-5', '2020-01-01T00:00:00.000Z', 'changeset'),
    ]);

    const outcome = computeChangesetOutcome(corpus, root);

    expect(outcome).toEqual({
      fires: 1,
      exact: 0,
      windowed: 0,
      recordEntries: 0,
      filesAdded: 0,
    });
  });

  it('tolerates an unparseable record line', () => {
    const root = tempRoot();
    writeFile(
      root,
      '.claude/state/changesets.jsonl',
      [
        'not json',
        JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', chat: 'sess-6' }),
      ].join('\n'),
    );
    const corpus = corpusFromLines([
      skillFireLine('sess-6', '2026-01-01T00:00:30.000Z', 'changeset'),
    ]);

    const outcome = computeChangesetOutcome(corpus, root);

    expect(outcome).toEqual({
      fires: 1,
      exact: 1,
      windowed: 0,
      recordEntries: 1,
      filesAdded: 0,
    });
  });

  it('reports all zeros when the record file and .changeset history are both missing', () => {
    const root = tempRoot();
    const corpus = corpusFromLines([]);

    const outcome = computeChangesetOutcome(corpus, root);

    expect(outcome).toEqual({
      fires: 0,
      exact: 0,
      windowed: 0,
      recordEntries: 0,
      filesAdded: 0,
    });
  });
});

function indexEntry(
  id: string,
  date: string,
  chat: string | null,
): LedgerEntry {
  return {
    id,
    itemId: '',
    issue: null,
    title: id,
    body: '',
    surface: 'cli',
    date,
    chat,
    status: null,
    scope: [],
    under: null,
    supersedes: [],
    supersededBy: null,
  };
}

function writeIndex(root: string, entries: LedgerEntry[]): void {
  writeFile(
    root,
    '.claude/ledgers/backlog.index.json',
    serializeIndex({
      ...emptyIndex('backlog', '2026-01-01T00:00:00.000Z'),
      entries,
    }),
  );
}

describe('computeLedgerOutcome', () => {
  it('matches an add entry to a fire from the same session', () => {
    const root = tempRoot();
    writeFile(
      root,
      '.claude/ledgers/backlog.jsonl',
      `${JSON.stringify({ action: 'add', chat: 'sess-7' })}\n`,
    );
    const corpus = corpusFromLines([
      skillFireLine('sess-7', '2026-01-01T00:00:00.000Z', 'backlog-add'),
    ]);

    const outcome = computeLedgerOutcome(
      corpus,
      root,
      'backlog.jsonl',
      'backlog-add',
    );

    expect(outcome).toEqual({
      skill: 'backlog-add',
      fires: 1,
      matched: 1,
      totalAdds: 1,
    });
  });

  it('tolerates an unparseable ledger line', () => {
    const root = tempRoot();
    writeFile(
      root,
      '.claude/ledgers/decisions.jsonl',
      ['not json', JSON.stringify({ action: 'add', chat: 'sess-8' })].join(
        '\n',
      ),
    );
    const corpus = corpusFromLines([
      skillFireLine('sess-8', '2026-01-01T00:00:00.000Z', 'decide'),
    ]);

    const outcome = computeLedgerOutcome(
      corpus,
      root,
      'decisions.jsonl',
      'decide',
    );

    expect(outcome).toEqual({
      skill: 'decide',
      fires: 1,
      matched: 1,
      totalAdds: 1,
    });
  });

  it('matches an index entry when the jsonl is empty', () => {
    const root = tempRoot();
    writeFile(root, '.claude/ledgers/backlog.jsonl', '');
    writeIndex(root, [indexEntry('A-1', '2026-01-01', 'sess-9')]);
    const corpus = corpusFromLines([
      skillFireLine('sess-9', '2026-03-01T00:00:00.000Z', 'backlog-add'),
    ]);

    expect(
      computeLedgerOutcome(corpus, root, 'backlog.jsonl', 'backlog-add'),
    ).toEqual({ skill: 'backlog-add', fires: 1, matched: 1, totalAdds: 1 });
  });

  it('does not match an index entry from another session outside the window', () => {
    const root = tempRoot();
    writeIndex(root, [indexEntry('A-1', '2026-01-01', 'sess-9')]);
    const corpus = corpusFromLines([
      skillFireLine('sess-other', '2026-03-01T00:00:00.000Z', 'backlog-add'),
    ]);

    expect(
      computeLedgerOutcome(corpus, root, 'backlog.jsonl', 'backlog-add'),
    ).toEqual({ skill: 'backlog-add', fires: 1, matched: 0, totalAdds: 1 });
  });

  it('counts an id held by both the jsonl and the index once', () => {
    const root = tempRoot();
    writeFile(
      root,
      '.claude/ledgers/backlog.jsonl',
      `${JSON.stringify({ action: 'add', id: 'A-1', chat: 'sess-9' })}\n`,
    );
    writeIndex(root, [
      indexEntry('A-1', '2026-01-01', 'sess-9'),
      indexEntry('A-2', '2026-01-02', 'sess-10'),
    ]);
    const corpus = corpusFromLines([
      skillFireLine('sess-9', '2026-03-01T00:00:00.000Z', 'backlog-add'),
    ]);

    expect(
      computeLedgerOutcome(corpus, root, 'backlog.jsonl', 'backlog-add'),
    ).toEqual({ skill: 'backlog-add', fires: 1, matched: 1, totalAdds: 2 });
  });

  it('reports zeros when the ledger file is missing', () => {
    const root = tempRoot();
    const corpus = corpusFromLines([]);

    const outcome = computeLedgerOutcome(
      corpus,
      root,
      'backlog.jsonl',
      'backlog-add',
    );

    expect(outcome).toEqual({
      skill: 'backlog-add',
      fires: 0,
      matched: 0,
      totalAdds: 0,
    });
  });
});

describe('renderSkillOutcomes', () => {
  it('renders the outcomes block with the changeset line and one line per ledger outcome', () => {
    const lines = renderSkillOutcomes(
      { fires: 3, exact: 1, windowed: 1, recordEntries: 2, filesAdded: 4 },
      [
        { skill: 'backlog-add', fires: 2, matched: 1, totalAdds: 5 },
        { skill: 'decide', fires: 1, matched: 0, totalAdds: 0 },
      ],
    );

    expect(lines).toEqual([
      '  outcomes:',
      '    /changeset:   fired 3, matched 1 via the outcome record and 1 via the 72h git window (2 record entries, 4 files added across history)',
      '    /backlog-add: fired 2, matched a ledger add for 1 (5 adds in the local ledger)',
      '    /decide:      fired 1, matched a ledger add for 0 (0 adds in the local ledger)',
      '    (ledger counts read the local .jsonl plus the synced index, so they undercount only entries neither holds)',
    ]);
  });
});
