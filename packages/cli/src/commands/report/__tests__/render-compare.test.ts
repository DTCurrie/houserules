import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { renderComparison } from '../render-compare.js';
import { buildReportDocument } from '../report-document.js';
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

    expect(cells(lines, 'turns')).toEqual(['turns', '3', '7']);
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
  ])('renders the %s title exactly once', (title) => {
    const lines = renderComparison([home, work]);

    expect(lines.filter((l) => l === `-- ${title} --`)).toHaveLength(1);
  });

  it('yields four columns for three documents', () => {
    const third = documentFor('lab', assistantTurns(1));

    const lines = renderComparison([home, work, third]);

    expect(cells(lines, 'turns')).toEqual(['turns', '3', '7', '1']);
  });
});
