import { describe, expect, it, onTestFinished } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      '    (ledger rates undercount where sync to GitHub Projects has pruned the local .jsonl)',
    ]);
  });
});
