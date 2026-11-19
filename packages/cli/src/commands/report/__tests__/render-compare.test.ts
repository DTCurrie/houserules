import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderComparison } from '../render-compare.js';
import {
  buildReportDocument,
  type ReportDocument,
} from '../report-document.js';
import { emptyCorpus, ingestTranscript } from '../transcript-events.js';

const NO_REPO = join(tmpdir(), 'no-such-repo-for-render-compare');

function assistantTurns(count: number): string {
  return Array.from({ length: count }, () =>
    JSON.stringify({
      type: 'assistant',
      sessionId: 's1',
      message: {
        role: 'assistant',
        model: 'claude-3-opus',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    }),
  ).join('\n');
}

const hookFire = JSON.stringify({
  type: 'attachment',
  sessionId: 's1',
  attachment: { hookName: 'PreToolUse:guard-bash', exitCode: 0 },
});

const skillUse = JSON.stringify({
  type: 'assistant',
  sessionId: 's1',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tu1',
        name: 'Skill',
        input: { skill: 'changeset' },
      },
    ],
  },
});

function documentFor(label: string, transcript: string) {
  const corpus = emptyCorpus(['slug']);
  ingestTranscript(corpus, 'sess-abcdef12.jsonl', transcript);
  return buildReportDocument(corpus, NO_REPO, { label, cliVersion: '0.0.0' });
}

function cells(lines: string[], metric: string): string[] {
  const found = lines.find((l) => l.trim().startsWith(metric));
  if (!found) throw new Error(`no row starting with ${metric}`);
  return found.trim().split(/\s{2,}/);
}

describe('renderComparison', () => {
  const home = documentFor('home', `${assistantTurns(3)}\n${hookFire}`);
  const work = documentFor('work', `${assistantTurns(6)}\n${skillUse}`);

  it('puts metric first and one column per label in order in the first table', () => {
    const lines = renderComparison([home, work]);

    expect(lines[0]).toBe('-- tokens --');
    expect(cells(lines, 'metric')).toEqual(['metric', 'home', 'work']);
  });

  it('carries each corpus turn count in label order', () => {
    const lines = renderComparison([home, work]);

    expect(cells(lines, 'turns')).toEqual(['turns', '3', '6']);
  });

  it('shows a dash under the label that never saw the hook', () => {
    const lines = renderComparison([home, work]);

    expect(cells(lines, 'fires: PreToolUse:guard-bash')).toEqual([
      'fires: PreToolUse:guard-bash',
      '1',
      '-',
    ]);
  });

  it('shows a dash under the label that never used the skill', () => {
    const lines = renderComparison([home, work]);

    expect(cells(lines, 'changeset (model+user)')).toEqual([
      'changeset (model+user)',
      '-',
      '1',
    ]);
  });

  it.each([
    'tokens',
    'hook health',
    'guard efficacy',
    'skill adoption',
    'skill outcomes',
    'friction',
    'resident context',
    'artifact episodes',
  ])('renders the %s title exactly once', (title) => {
    const lines = renderComparison([home, work]);

    expect(lines.filter((l) => l === `-- ${title} --`)).toHaveLength(1);
  });

  it('yields four columns for three documents', () => {
    const third = documentFor('lab', assistantTurns(1));

    const lines = renderComparison([home, work, third]);

    expect(cells(lines, 'turns')).toEqual(['turns', '3', '6', '1']);
  });
});

describe('renderComparison on an old document beside a new one', () => {
  const old = JSON.parse(
    JSON.stringify(documentFor('old', assistantTurns(2))),
    (key, value: unknown) =>
      key === 'cacheWrite1h' ||
      key === 'stopHooks' ||
      key === 'toolResultSizes' ||
      key === 'artifacts'
        ? undefined
        : value,
  ) as ReportDocument;
  const slice = {
    turns: 1,
    input: 1_000_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 1_000_000,
  };
  const fresh: ReportDocument = {
    ...documentFor('new', assistantTurns(2)),
  };
  fresh.tokens = {
    ...fresh.tokens,
    totals: { ...fresh.tokens.totals, cacheWrite1h: 500_000 },
    files: [
      {
        ...(fresh.tokens.files[0] as ReportDocument['tokens']['files'][number]),
        byModel: {
          'claude-sonnet-5-5': { ...slice, cacheWrite1h: 500_000 },
        },
      },
    ],
  };
  fresh.hooks = {
    ...fresh.hooks,
    stopHooks: [
      { hook: 'a.mjs', runs: 4, p50: 1, p95: 2, max: 3, timeouts: 0 },
      {
        hook: '(per Stop total)',
        runs: 4,
        p50: 5,
        p95: 1500,
        max: 9,
        timeouts: 0,
      },
    ],
  };
  fresh.friction = {
    ...fresh.friction,
    toolResultSizes: {
      capBytes: 16384,
      read: { results: 3, bytes: 99999, overCap: 2 },
      bash: { results: 1, bytes: 10, overCap: 0 },
    },
  };
  fresh.artifacts = {
    episodes: [
      {
        session: 'abcdef12',
        artifactCalls: 1,
        commentCalls: 0,
        publishes: 1,
        requests: 1,
        output: 1,
        weightedInput: 1,
        sessionWeightedInput: 1,
      },
    ],
  };
  const lines = renderComparison([old, fresh]);

  it('shows a dash for the old document and the count for the new one', () => {
    expect(cells(lines, 'cache write (1-hour)')).toEqual([
      'cache write (1-hour)',
      '-',
      '500,000',
    ]);
    expect(cells(lines, 'stop runs')).toEqual(['stop runs', '-', '4']);
    expect(cells(lines, 'stop p95 ms (per Stop)')).toEqual([
      'stop p95 ms (per Stop)',
      '-',
      '1,500',
    ]);
    expect(cells(lines, 'Read results over trim cap')).toEqual([
      'Read results over trim cap',
      '-',
      '2',
    ]);
    expect(cells(lines, 'Bash results over trim cap')).toEqual([
      'Bash results over trim cap',
      '-',
      '0',
    ]);
    expect(cells(lines, 'episodes')).toEqual(['episodes', '-', '1']);
  });

  it('prices the new document from its model slices, and dashes one whose models have no price row', () => {
    // sonnet-5-5: fresh $2, plus writes of 500k at 1.25x and 500k at 2x of $2 = $3.25. The old document's only model has no price row.
    expect(cells(lines, 'list price ($)')).toEqual([
      'list price ($)',
      '-',
      '5.25',
    ]);
  });
});
