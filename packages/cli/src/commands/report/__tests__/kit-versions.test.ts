import { describe, expect, it } from 'vitest';

import { computeKitVersions, renderKitVersions } from '../kit-versions.js';
import { emptyCorpus, ingestTranscript } from '../transcript-events.js';

function banner(
  sessionId: string,
  content: string,
  hookName = 'SessionStart:startup',
) {
  return JSON.stringify({
    type: 'attachment',
    sessionId,
    attachment: { hookName, content },
  });
}

function corpusOf(files: Record<string, string[]>) {
  const corpus = emptyCorpus(['slug']);
  for (const [name, lines] of Object.entries(files))
    ingestTranscript(corpus, `${name}.jsonl`, lines.join('\n'));
  return corpus;
}

describe('computeKitVersions', () => {
  it('reports each session on its own banner version', () => {
    const corpus = corpusOf({
      a: [banner('a', '[houserules] kit 1.2.0')],
      b: [banner('b', '[houserules] kit 1.3.1')],
    });

    expect(computeKitVersions(corpus, '9.9.9').rows).toEqual([
      { sessionId: 'a', version: '1.2.0', source: 'banner' },
      { sessionId: 'b', version: '1.3.1', source: 'banner' },
    ]);
  });

  it('gives a session with no line the recorded version, marked', () => {
    const corpus = corpusOf({
      a: [banner('a', 'other output')],
      b: [JSON.stringify({ type: 'user', sessionId: 'b' })],
    });
    const report = computeKitVersions(corpus, '1.0.0');

    expect(report.rows.map((row) => row.source)).toEqual([
      'recorded',
      'recorded',
    ]);
    expect(renderKitVersions(report).join('\n')).toContain(
      '1.0.0 (recorded): 2 session(s)',
    );
  });

  it('keeps the first banner when a resumed session replays another', () => {
    const corpus = corpusOf({
      a: [
        banner('a', '[houserules] kit 1.2.0'),
        banner('a', '[houserules] kit 1.4.0', 'SessionStart:resume'),
      ],
    });

    expect(computeKitVersions(corpus, '9.9.9').rows[0]?.version).toBe('1.2.0');
  });

  it('parses the line out of multi-line hook content', () => {
    const corpus = corpusOf({
      a: [
        banner(
          'a',
          '[houserules] payload synced\n[houserules] kit 2.0.0-beta.1\n[houserules] done',
        ),
      ],
    });

    expect(computeKitVersions(corpus, '9.9.9').rows[0]).toEqual({
      sessionId: 'a',
      version: '2.0.0-beta.1',
      source: 'banner',
    });
  });

  it('groups sessions by version with counts', () => {
    const corpus = corpusOf({
      a: [banner('a', '[houserules] kit 1.2.0')],
      b: [banner('b', '[houserules] kit 1.2.0')],
      c: [banner('c', '[houserules] kit 1.3.0')],
    });

    expect(renderKitVersions(computeKitVersions(corpus, '1.0.0'))).toEqual([
      '-- kit versions --',
      '',
      '  1.2.0: 2 session(s)',
      '  1.3.0: 1 session(s)',
    ]);
  });

  it('renders nothing for a document exported before the section', () => {
    expect(renderKitVersions(undefined)).toEqual([]);
  });
});
