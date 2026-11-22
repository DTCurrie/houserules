import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildReportDocument } from '../report-document.js';
import { emptyCorpus, ingestTranscript } from '../transcript-events.js';

describe('buildReportDocument bashWall', () => {
  it('carries the family table over the corpus Bash calls', () => {
    const corpus = emptyCorpus(['slug']);
    const records = [
      {
        type: 'assistant',
        timestamp: '2026-10-01T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'b1',
              name: 'Bash',
              input: { command: 'pnpm --filter @x/y run test' },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-10-01T10:00:07.500Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'b1', content: '' }],
        },
      },
    ];
    ingestTranscript(
      corpus,
      'sess-1.jsonl',
      records.map((record) => JSON.stringify(record)).join('\n'),
    );

    const document = buildReportDocument(
      corpus,
      mkdtempSync(join(tmpdir(), 'report-document-')),
      { label: 'work', cliVersion: '0.7.0' },
    );

    expect(document.bashWall?.families[0]).toEqual({
      family: 'pnpm test',
      calls: 1,
      subagentCalls: 0,
      seconds: 7.5,
      medianSeconds: 7.5,
      p90Seconds: 7.5,
    });
  });
});
