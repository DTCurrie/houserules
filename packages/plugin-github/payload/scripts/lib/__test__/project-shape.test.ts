import { describe, expect, it } from 'vitest';

import {
  appendMarker,
  fieldsFor,
  formatMarker,
  parseMarker,
  projectTitle,
  targetSegment,
} from '../project-shape.mjs';

describe('projectTitle', () => {
  it('names the root backlog project after the repo', () => {
    expect(projectTitle('schoolyard-games', 'backlog', null)).toBe(
      'schoolyard-games Backlog',
    );
  });

  it('names the root decisions project after the repo', () => {
    expect(projectTitle('schoolyard-games', 'decisions', null)).toBe(
      'schoolyard-games Decisions',
    );
  });

  it('names a target backlog project by repo slash target', () => {
    expect(projectTitle('schoolyard-games', 'backlog', 'studio')).toBe(
      'schoolyard-games/studio Backlog',
    );
  });

  it('names a target decisions project by repo slash target', () => {
    expect(projectTitle('schoolyard-games', 'decisions', 'studio')).toBe(
      'schoolyard-games/studio Decisions',
    );
  });
});

describe('targetSegment', () => {
  it('has no segment for the repo root', () => {
    expect(targetSegment({ name: null })).toBe(null);
  });

  it('takes the last directory of pathPrefix rather than the target name', () => {
    expect(
      targetSegment({ name: 'agent-kit', pathPrefix: 'packages/cli/' }),
    ).toBe('cli');
  });

  it('keeps a package directory name that carries dashes', () => {
    expect(
      targetSegment({ name: 'prose', pathPrefix: 'packages/plugin-prose/' }),
    ).toBe('plugin-prose');
  });

  it('tolerates a pathPrefix with no trailing slash', () => {
    expect(targetSegment({ name: 'test', pathPrefix: 'packages/test' })).toBe(
      'test',
    );
  });

  it('falls back to the target name when pathPrefix is empty', () => {
    expect(targetSegment({ name: 'studio', pathPrefix: '' })).toBe('studio');
  });

  it('falls back to the target name when pathPrefix is absent', () => {
    expect(targetSegment({ name: 'studio' })).toBe('studio');
  });

  it('distinguishes a target from the root when the two share a name', () => {
    const root = projectTitle(
      'agent-kit',
      'backlog',
      targetSegment({ name: null }),
    );
    const cli = projectTitle(
      'agent-kit',
      'backlog',
      targetSegment({ name: 'agent-kit', pathPrefix: 'packages/cli/' }),
    );

    expect([root, cli]).toEqual(['agent-kit Backlog', 'agent-kit/cli Backlog']);
  });
});

describe('fieldsFor backlog', () => {
  it('carries the five backlog fields in order', () => {
    expect(fieldsFor('backlog').map((f) => f.name)).toEqual([
      'Status',
      'Iteration',
      'Estimate',
      'Priority',
      'Area',
    ]);
  });

  it('offers Todo, In Progress, and Done for Status', () => {
    expect(fieldsFor('backlog')).toContainEqual({
      name: 'Status',
      dataType: 'SINGLE_SELECT',
      options: [
        { name: 'Todo', color: 'GRAY', description: 'Logged, not started' },
        {
          name: 'In Progress',
          color: 'YELLOW',
          description: 'Being worked on',
        },
        { name: 'Done', color: 'GREEN', description: 'Resolved' },
      ],
    });
  });

  it('offers P0, P1, and P2 for Priority', () => {
    expect(fieldsFor('backlog')).toContainEqual({
      name: 'Priority',
      dataType: 'SINGLE_SELECT',
      options: [
        { name: 'P0', color: 'RED', description: 'Blocking' },
        { name: 'P1', color: 'ORANGE', description: 'Next' },
        { name: 'P2', color: 'BLUE', description: 'Someday' },
      ],
    });
  });

  it('types Estimate as a number', () => {
    expect(fieldsFor('backlog')).toContainEqual({
      name: 'Estimate',
      dataType: 'NUMBER',
    });
  });

  it('types Area as text', () => {
    expect(fieldsFor('backlog')).toContainEqual({
      name: 'Area',
      dataType: 'TEXT',
    });
  });

  it('pins Iteration to a fixed 14-day duration and start date', () => {
    expect(fieldsFor('backlog')).toContainEqual({
      name: 'Iteration',
      dataType: 'ITERATION',
      iteration: { startDate: '2026-01-01', duration: 14 },
    });
  });
});

describe('fieldsFor decisions', () => {
  it('carries the five decisions fields in order', () => {
    expect(fieldsFor('decisions').map((f) => f.name)).toEqual([
      'Status',
      'Decided',
      'Supersedes',
      'Superseded by',
      'Chat',
    ]);
  });

  it('offers Accepted and Superseded for Status', () => {
    expect(fieldsFor('decisions')).toContainEqual({
      name: 'Status',
      dataType: 'SINGLE_SELECT',
      options: [
        { name: 'Accepted', color: 'GREEN', description: 'Current decision' },
        {
          name: 'Superseded',
          color: 'GRAY',
          description: 'Replaced by a later decision',
        },
      ],
    });
  });

  it('types Decided as a date', () => {
    expect(fieldsFor('decisions')).toContainEqual({
      name: 'Decided',
      dataType: 'DATE',
    });
  });

  it('types Supersedes and Chat as text', () => {
    expect(fieldsFor('decisions')).toContainEqual({
      name: 'Supersedes',
      dataType: 'TEXT',
    });
    expect(fieldsFor('decisions')).toContainEqual({
      name: 'Chat',
      dataType: 'TEXT',
    });
  });

  it('carries no iteration field', () => {
    expect(fieldsFor('decisions').some((f) => f.dataType === 'ITERATION')).toBe(
      false,
    );
  });
});

describe('formatMarker', () => {
  it('wraps the entry id in an HTML comment', () => {
    expect(formatMarker('TEST-abc123')).toBe(
      '<!-- agent-kit:entry:TEST-abc123 -->',
    );
  });
});

describe('parseMarker', () => {
  it('extracts the entry id from a body carrying a marker', () => {
    expect(
      parseMarker('Some report text.\n\n<!-- agent-kit:entry:TEST-abc123 -->'),
    ).toBe('TEST-abc123');
  });

  it('returns null for a body with no marker', () => {
    expect(parseMarker('Just a plain issue body.')).toBeNull();
  });

  it('returns null for a body carrying a different HTML comment', () => {
    expect(parseMarker('Body text.\n\n<!-- some other comment -->')).toBeNull();
  });

  it('returns null for prose that merely resembles a marker', () => {
    expect(
      parseMarker('The marker is agent-kit:entry:TEST-abc123, apparently.'),
    ).toBeNull();
  });
});

describe('appendMarker', () => {
  it('appends the marker to a body carrying none', () => {
    expect(appendMarker('Reported bug.', 'TEST-abc123')).toBe(
      'Reported bug.\n\n<!-- agent-kit:entry:TEST-abc123 -->',
    );
  });

  it('is a no-op when the body already carries a marker', () => {
    const body = 'Reported bug.\n\n<!-- agent-kit:entry:TEST-abc123 -->';

    expect(appendMarker(body, 'TEST-xyz789')).toBe(body);
  });

  it('round-trips through parseMarker for a body with no trailing whitespace', () => {
    const body = appendMarker('Reported bug.', 'TEST-abc123');

    expect(parseMarker(body)).toBe('TEST-abc123');
  });

  it('round-trips through parseMarker for a body with trailing whitespace', () => {
    const body = appendMarker('Reported bug.\n\n  \n', 'TEST-abc123');

    expect(parseMarker(body)).toBe('TEST-abc123');
  });

  it('is idempotent across two calls with different ids, keeping the first', () => {
    const once = appendMarker('Reported bug.', 'TEST-abc123');
    const twice = appendMarker(once, 'TEST-different');

    expect(twice).toBe(once);
    expect(parseMarker(twice)).toBe('TEST-abc123');
  });
});

describe('single select options', () => {
  it('gives every option a description, which the GitHub input requires', () => {
    const options = [...fieldsFor('backlog'), ...fieldsFor('decisions')]
      .filter((field) => field.dataType === 'SINGLE_SELECT')
      .flatMap((field) => field.options);

    expect(options.filter((option) => !option.description)).toEqual([]);
  });
});
