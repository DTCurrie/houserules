import { describe, expect, it } from 'vitest';

import {
  computeArtifactEpisodes,
  renderArtifactEpisodes,
} from '../artifact-episodes.js';
import { emptyCorpus, ingestTranscript } from '../transcript-events.js';

const SESSION = 'abcdef1234567890';
const MINUTE = 60_000;
const START = Date.parse('2026-11-01T10:00:00.000Z');

interface Turn {
  minute: number;
  model?: string;
  output?: number;
  tool?: { name: string; input?: Record<string, unknown> };
  sidechain?: boolean;
}

let nextId = 0;

function turnLine(turn: Turn): string {
  nextId += 1;
  return JSON.stringify({
    type: 'assistant',
    sessionId: SESSION,
    isSidechain: turn.sidechain === true,
    timestamp: new Date(START + turn.minute * MINUTE).toISOString(),
    message: {
      id: `msg-${nextId}`,
      role: 'assistant',
      model: turn.model ?? 'claude-fable-5-2',
      content: turn.tool
        ? [
            {
              type: 'tool_use',
              id: `tool-${nextId}`,
              name: turn.tool.name,
              input: turn.tool.input ?? {},
            },
          ]
        : [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 100,
        output_tokens: turn.output ?? 10,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

function corpusOf(turns: Turn[]) {
  const corpus = emptyCorpus(['slug']);
  ingestTranscript(corpus, `${SESSION}.jsonl`, turns.map(turnLine).join('\n'));
  return corpus;
}

/**
 * One response written the way Claude Code writes it: a thinking record, then a later record
 * carrying the tool_use, both with the same message id and usage.
 */
function thinkingThenCallLines(
  thinkingMinute: number,
  callMinute: number,
  action: string,
): string[] {
  const [thinking, call] = [
    turnLine({ minute: thinkingMinute }),
    turnLine(artifact(callMinute, action)),
  ].map((line) => JSON.parse(line) as { message: Record<string, unknown> });
  if (!thinking || !call) throw new Error('turnLine returned no record');
  thinking.message.content = [{ type: 'thinking', thinking: '' }];
  call.message.id = thinking.message.id;
  return [JSON.stringify(thinking), JSON.stringify(call)];
}

const artifact = (minute: number, action?: string): Turn => ({
  minute,
  tool: { name: 'Artifact', input: action ? { action } : {} },
});

describe('computeArtifactEpisodes', () => {
  it('opens the episode at the quickstart and closes it at the last publish', () => {
    const corpus = corpusOf([
      { minute: 0, output: 5 },
      artifact(1, 'quickstart'),
      { minute: 2, output: 20 },
      artifact(3, 'publish'),
      { minute: 4, output: 30 },
      artifact(5, 'publish'),
      { minute: 6, output: 7 },
    ]);

    const [episode] = computeArtifactEpisodes(corpus).episodes;

    expect(episode).toMatchObject({
      session: 'abcdef12',
      artifactCalls: 3,
      publishes: 2,
      requests: 5,
      output: 10 + 20 + 10 + 30 + 10,
      wallMs: 4 * MINUTE,
    });
  });

  it('opens at the request that issued the quickstart when its thinking block is stamped before the call', () => {
    const corpus = emptyCorpus(['slug']);
    const lines = [
      turnLine({ minute: 0 }),
      ...thinkingThenCallLines(1, 2, 'quickstart'),
      turnLine({ minute: 3 }),
      turnLine(artifact(4, 'publish')),
      turnLine({ minute: 5 }),
    ];
    ingestTranscript(corpus, `${SESSION}.jsonl`, lines.join('\n'));

    const [episode] = computeArtifactEpisodes(corpus).episodes;

    expect(
      episode,
      'a window opened at the tool_use record drops the quickstart request: 2 requests, 1 min',
    ).toMatchObject({ requests: 3, output: 30, wallMs: 3 * MINUTE });
  });

  it('opens at the first publish when a publish names no action and there is no quickstart', () => {
    const corpus = corpusOf([
      { minute: 0 },
      { minute: 1 },
      artifact(2),
      { minute: 3 },
      artifact(4),
      { minute: 5 },
    ]);

    const [episode] = computeArtifactEpisodes(corpus).episodes;

    expect(episode).toMatchObject({
      artifactCalls: 2,
      publishes: 2,
      requests: 3,
      wallMs: 2 * MINUTE,
    });
  });

  it('does not count a read or a quickstart as a publish', () => {
    const corpus = corpusOf([
      artifact(0, 'quickstart'),
      artifact(1, 'read'),
      artifact(2, 'publish'),
    ]);

    const [episode] = computeArtifactEpisodes(corpus).episodes;

    expect(episode).toMatchObject({ artifactCalls: 3, publishes: 1 });
  });

  it('lists a session that never published, windowed from its first call to its last', () => {
    const corpus = corpusOf([
      { minute: 0 },
      artifact(1, 'quickstart'),
      { minute: 2 },
      artifact(3, 'read'),
      { minute: 4 },
    ]);

    const [episode] = computeArtifactEpisodes(corpus).episodes;

    expect(episode).toMatchObject({
      artifactCalls: 2,
      publishes: 0,
      requests: 3,
      wallMs: 2 * MINUTE,
    });
  });

  it('counts ArtifactComments calls on the main chain', () => {
    const corpus = corpusOf([
      artifact(0, 'quickstart'),
      { minute: 1, tool: { name: 'ArtifactComments' } },
      { minute: 2, tool: { name: 'ArtifactComments' } },
      artifact(3, 'publish'),
    ]);

    const [episode] = computeArtifactEpisodes(corpus).episodes;

    expect(episode?.commentCalls).toBe(2);
  });

  it('ignores an Artifact call made on a subagent chain', () => {
    const corpus = corpusOf([
      { minute: 0 },
      { minute: 1, sidechain: true, tool: { name: 'Artifact' } },
    ]);

    expect(computeArtifactEpisodes(corpus).episodes).toEqual([]);
  });

  it('names the model that ran most of the episode requests', () => {
    const corpus = corpusOf([
      { ...artifact(0, 'quickstart'), model: 'claude-fable-5-1' },
      { minute: 1, model: 'claude-fable-5-2' },
      { minute: 2, model: 'claude-fable-5-2' },
      { minute: 3, model: 'claude-fable-5-2' },
      { ...artifact(4, 'publish'), model: 'claude-fable-5-1' },
    ]);

    const [episode] = computeArtifactEpisodes(corpus).episodes;

    expect(episode?.model).toBe('claude-fable-5-2');
  });

  it('weights the episode and divides it by the whole session', () => {
    const corpus = corpusOf([
      { minute: 0 },
      artifact(1, 'quickstart'),
      artifact(2, 'publish'),
      { minute: 3 },
    ]);

    const [episode] = computeArtifactEpisodes(corpus).episodes;

    expect(episode).toMatchObject({
      weightedInput: 2 * 200,
      sessionWeightedInput: 4 * 200,
    });
  });
});

describe('renderArtifactEpisodes', () => {
  it('renders nothing for a document exported before the section existed', () => {
    expect(renderArtifactEpisodes(undefined)).toEqual([]);
  });

  it('says no Artifact calls were recorded when the report has no episodes', () => {
    expect(renderArtifactEpisodes({ episodes: [] })).toEqual([
      '-- artifact episodes --',
      '  No Artifact calls were recorded.',
    ]);
  });

  it('prints one row per episode with the share of its session', () => {
    const corpus = corpusOf([
      { minute: 0 },
      artifact(1, 'quickstart'),
      artifact(2, 'publish'),
      { minute: 3 },
    ]);

    const lines = renderArtifactEpisodes(computeArtifactEpisodes(corpus));

    expect(lines.slice(0, 2).map((row) => row.trim().split(/\s{2,}/))).toEqual([
      ['-- artifact episodes --'],
      [
        'session',
        'calls',
        'comments',
        'publishes',
        'requests',
        'wall',
        'output',
        'weighted-in',
        'share of session',
        'model',
      ],
    ]);
    expect(lines[3]?.trim().split(/\s{2,}/)).toEqual([
      'abcdef12',
      '2',
      '0',
      '1',
      '2',
      '1.0 min',
      '20',
      '400',
      '50.0%',
      'claude-fable-5-2',
    ]);
  });
});
