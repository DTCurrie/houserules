import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { emptyCorpus, ingestTranscript } from '../transcript-events.js';
import {
  computeSkillAdoption,
  renderSkillAdoption,
} from '../skill-adoption.js';
import { renderTable } from '../render-table.js';

function lines(...records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

describe('computeSkillAdoption', () => {
  it('counts a model-initiated Skill tool call', () => {
    const corpus = emptyCorpus(['proj']);
    const text = lines({
      type: 'assistant',
      sessionId: 's1',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'Skill',
            input: { skill: 'alpha' },
          },
        ],
      },
    });

    ingestTranscript(corpus, 'a.jsonl', text);
    const report = computeSkillAdoption(
      corpus,
      join(tmpdir(), 'no-such-skills-dir'),
    );

    expect(report.counts).toEqual([{ skill: 'alpha', model: 1, user: 0 }]);
  });

  it('counts a user-typed slash command from array-content text blocks', () => {
    const corpus = emptyCorpus(['proj']);
    const text = lines({
      type: 'user',
      sessionId: 's1',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'please run <command-name>/beta</command-name> now',
          },
        ],
      },
    });

    ingestTranscript(corpus, 'a.jsonl', text);
    const report = computeSkillAdoption(
      corpus,
      join(tmpdir(), 'no-such-skills-dir'),
    );

    expect(report.counts).toEqual([{ skill: 'beta', model: 0, user: 1 }]);
  });

  it('counts a user-typed slash command from string-content messages', () => {
    const corpus = emptyCorpus(['proj']);
    const text = lines({
      type: 'user',
      sessionId: 's2',
      uuid: 'u2',
      message: { role: 'user', content: '<command-name>/gamma</command-name>' },
    });

    ingestTranscript(corpus, 'a.jsonl', text);
    const report = computeSkillAdoption(
      corpus,
      join(tmpdir(), 'no-such-skills-dir'),
    );

    expect(report.counts).toEqual([{ skill: 'gamma', model: 0, user: 1 }]);
  });

  it('dedupes a resumed session on message uuid but counts a distinct uuid separately', () => {
    const corpus = emptyCorpus(['proj']);
    const text = lines(
      {
        type: 'user',
        sessionId: 's3',
        uuid: 'u3',
        message: {
          role: 'user',
          content: '<command-name>/delta</command-name>',
        },
      },
      {
        type: 'user',
        sessionId: 's3',
        uuid: 'u3',
        message: {
          role: 'user',
          content: '<command-name>/delta</command-name>',
        },
      },
      {
        type: 'user',
        sessionId: 's3',
        uuid: 'u4',
        message: {
          role: 'user',
          content: '<command-name>/delta</command-name>',
        },
      },
    );

    ingestTranscript(corpus, 'a.jsonl', text);
    const report = computeSkillAdoption(
      corpus,
      join(tmpdir(), 'no-such-skills-dir'),
    );

    expect(report.counts).toEqual([{ skill: 'delta', model: 0, user: 2 }]);
  });

  it('ignores an isMeta user record', () => {
    const corpus = emptyCorpus(['proj']);
    const text = lines({
      type: 'user',
      sessionId: 's1',
      uuid: 'u5',
      isMeta: true,
      message: {
        role: 'user',
        content: '<command-name>/epsilon</command-name>',
      },
    });

    ingestTranscript(corpus, 'a.jsonl', text);
    const report = computeSkillAdoption(
      corpus,
      join(tmpdir(), 'no-such-skills-dir'),
    );

    expect(report.counts).toEqual([]);
  });

  it('skips a malformed transcript line without throwing', () => {
    const corpus = emptyCorpus(['proj']);
    const text = [
      '{not valid json',
      lines({
        type: 'assistant',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'Skill',
              input: { skill: 'zeta' },
            },
          ],
        },
      }),
    ].join('\n');

    ingestTranscript(corpus, 'a.jsonl', text);
    const report = computeSkillAdoption(
      corpus,
      join(tmpdir(), 'no-such-skills-dir'),
    );

    expect(report.counts).toEqual([{ skill: 'zeta', model: 1, user: 0 }]);
  });

  it('sorts counts by combined model plus user total descending', () => {
    const corpus = emptyCorpus(['proj']);
    const text = lines(
      {
        type: 'assistant',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'Skill',
              input: { skill: 'low' },
            },
          ],
        },
      },
      {
        type: 'assistant',
        sessionId: 's1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'tu2',
              name: 'Skill',
              input: { skill: 'high' },
            },
            {
              type: 'tool_use',
              id: 'tu3',
              name: 'Skill',
              input: { skill: 'high' },
            },
            {
              type: 'tool_use',
              id: 'tu4',
              name: 'Skill',
              input: { skill: 'high' },
            },
          ],
        },
      },
    );

    ingestTranscript(corpus, 'a.jsonl', text);
    const report = computeSkillAdoption(
      corpus,
      join(tmpdir(), 'no-such-skills-dir'),
    );

    expect(report.counts).toEqual([
      { skill: 'high', model: 3, user: 0 },
      { skill: 'low', model: 1, user: 0 },
    ]);
  });

  it('counts toolset-active sessions as sessions with at least one hook fire', () => {
    const corpus = emptyCorpus(['proj']);
    const text = lines(
      {
        type: 'attachment',
        sessionId: 'active',
        attachment: { hookName: 'PreToolUse' },
      },
      {
        type: 'user',
        sessionId: 'idle',
        uuid: 'u6',
        message: {
          role: 'user',
          content: '<command-name>/theta</command-name>',
        },
      },
    );

    ingestTranscript(corpus, 'a.jsonl', text);
    const report = computeSkillAdoption(
      corpus,
      join(tmpdir(), 'no-such-skills-dir'),
    );

    expect(report.toolsetActiveSessions).toBe(1);
    expect(report.totalSessions).toBe(2);
  });

  it('lists installed skill directories and the ones with zero fires as dead', () => {
    const corpus = emptyCorpus(['proj']);
    const text = lines({
      type: 'assistant',
      sessionId: 's1',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'Skill',
            input: { skill: 'alpha' },
          },
        ],
      },
    });
    ingestTranscript(corpus, 'a.jsonl', text);

    const skillsDir = mkdtempSync(join(tmpdir(), 'skill-adoption-'));
    mkdirSync(join(skillsDir, 'alpha'));
    mkdirSync(join(skillsDir, 'zzz-dead'));

    try {
      const report = computeSkillAdoption(corpus, skillsDir);

      expect(report.installed.sort()).toEqual(['alpha', 'zzz-dead']);
      expect(report.dead).toEqual(['zzz-dead']);
    } finally {
      rmSync(skillsDir, { recursive: true, force: true });
    }
  });

  it('reports no installed skills when the skills directory does not exist', () => {
    const corpus = emptyCorpus(['proj']);

    const report = computeSkillAdoption(
      corpus,
      join(tmpdir(), 'no-such-skills-dir'),
    );

    expect(report.installed).toEqual([]);
    expect(report.dead).toEqual([]);
  });
});

describe('renderSkillAdoption', () => {
  it('renders the no-fires message and the denominator line for an empty report', () => {
    const rendered = renderSkillAdoption({
      counts: [],
      installed: [],
      dead: [],
      toolsetActiveSessions: 0,
      totalSessions: 0,
    });

    expect(rendered).toEqual([
      '-- skills --',
      '',
      '  no skill fires in this corpus',
      '  toolset-active sessions: 0 of 0 (any hook fire; adoption reads against these)',
    ]);
  });

  it('renders the table, the legend, the denominator, and the dead-skill caveat', () => {
    const table = renderTable(
      ['skill', 'model', 'user', 'total'],
      [
        ['alpha', 2, 1, 3],
        ['beta', 0, 1, 1],
      ],
    );

    const rendered = renderSkillAdoption({
      counts: [
        { skill: 'alpha', model: 2, user: 1 },
        { skill: 'beta', model: 0, user: 1 },
      ],
      installed: ['alpha', 'beta', 'gamma'],
      dead: ['gamma'],
      toolsetActiveSessions: 3,
      totalSessions: 5,
    });

    expect(rendered).toEqual([
      '-- skills --',
      '',
      ...table,
      '',
      '  (model = Skill tool invocations; user = typed slash commands, built-ins included)',
      '  toolset-active sessions: 3 of 5 (any hook fire; adoption reads against these)',
      '',
      '  dead skills (installed, zero fires): gamma',
      '  (an unfired skill leaves no transcript trace, so dead cannot tell ignored from newly installed)',
    ]);
  });

  it('renders "none" for dead skills when every installed skill has fired', () => {
    const rendered = renderSkillAdoption({
      counts: [{ skill: 'alpha', model: 1, user: 0 }],
      installed: ['alpha'],
      dead: [],
      toolsetActiveSessions: 1,
      totalSessions: 1,
    });

    expect(rendered.at(-2)).toBe('  dead skills (installed, zero fires): none');
    expect(rendered.at(-1)).toBe(
      '  (an unfired skill leaves no transcript trace, so dead cannot tell ignored from newly installed)',
    );
  });
});
