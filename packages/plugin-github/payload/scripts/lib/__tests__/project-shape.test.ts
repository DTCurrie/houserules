import { describe, expect, it } from 'vitest';

import {
  appendMarker,
  fieldsFor,
  formatMarker,
  parseMarker,
  areaForSurface,
  projectTitle,
  surfaceForArea,
} from '../project-shape.mjs';

describe('projectTitle', () => {
  it('names the backlog project after the repo', () => {
    expect(projectTitle('schoolyard-games', 'backlog')).toBe(
      'schoolyard-games Backlog',
    );
  });

  it('names the decisions project after the repo', () => {
    expect(projectTitle('schoolyard-games', 'decisions')).toBe(
      'schoolyard-games Decisions',
    );
  });

  it('gives one repo exactly two titles, however many targets it declares', () => {
    const titles = new Set([
      projectTitle('houserules', 'backlog'),
      projectTitle('houserules', 'decisions'),
    ]);

    expect([...titles]).toEqual(['houserules Backlog', 'houserules Decisions']);
  });
});

describe('areaForSurface and surfaceForArea', () => {
  it('reads a target name off a backlog surface', () => {
    expect(areaForSurface('studio.BACKLOG.md')).toBe('studio');
  });

  it('reads a target name off a decisions surface', () => {
    expect(areaForSurface('studio.DECISIONS.md')).toBe('studio');
  });

  it('names the repo root surface readably rather than as an empty string', () => {
    expect(areaForSurface('BACKLOG.md')).toBe('repo root');
  });

  it.each([
    { surface: 'studio.BACKLOG.md', kind: 'backlog' as const },
    { surface: 'studio.DECISIONS.md', kind: 'decisions' as const },
    { surface: 'BACKLOG.md', kind: 'backlog' as const },
    { surface: 'DECISIONS.md', kind: 'decisions' as const },
  ])('round-trips $surface through its area', ({ surface, kind }) => {
    expect(surfaceForArea(areaForSurface(surface), kind)).toBe(surface);
  });

  it('treats an empty area as the repo root, for an item whose field was never set', () => {
    expect(surfaceForArea('', 'decisions')).toBe('DECISIONS.md');
  });
});

describe('fieldsFor backlog', () => {
  it('carries the seven backlog fields in order', () => {
    expect(fieldsFor('backlog').map((f) => f.name)).toEqual([
      'Status',
      'Iteration',
      'Estimate',
      'Priority',
      'Area',
      'Filed',
      'Chat',
    ]);
  });

  it('carries a Filed date and a Chat text field, which the index cannot derive from an item', () => {
    expect(fieldsFor('backlog')).toContainEqual({
      name: 'Filed',
      dataType: 'DATE',
    });
    expect(fieldsFor('backlog')).toContainEqual({
      name: 'Chat',
      dataType: 'TEXT',
    });
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
  it('carries the eight decisions fields in order', () => {
    expect(fieldsFor('decisions').map((f) => f.name)).toEqual([
      'Status',
      'Decided',
      'Supersedes',
      'Superseded by',
      'Chat',
      'Scope',
      'Under',
      'Area',
    ]);
  });

  it('carries Scope, Under, and Area, without which a pulled index cannot answer a scope query', () => {
    expect(
      fieldsFor('decisions')
        .filter((f) => ['Scope', 'Under', 'Area'].includes(f.name))
        .map((f) => f.dataType),
    ).toEqual(['TEXT', 'TEXT', 'TEXT']);
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

  it('names its target column Area, the same as backlog does, since one board holds every target', () => {
    expect(fieldsFor('decisions')).toContainEqual({
      name: 'Area',
      dataType: 'TEXT',
    });
    expect(fieldsFor('decisions').some((f) => f.name === 'Surface')).toBe(
      false,
    );
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
      '<!-- houserules:entry:TEST-abc123 -->',
    );
  });
});

describe('parseMarker', () => {
  it('extracts the entry id from a body carrying a marker', () => {
    expect(
      parseMarker('Some report text.\n\n<!-- houserules:entry:TEST-abc123 -->'),
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
      parseMarker('The marker is houserules:entry:TEST-abc123, apparently.'),
    ).toBeNull();
  });
});

describe('appendMarker', () => {
  it('appends the marker to a body carrying none', () => {
    expect(appendMarker('Reported bug.', 'TEST-abc123')).toBe(
      'Reported bug.\n\n<!-- houserules:entry:TEST-abc123 -->',
    );
  });

  it('is a no-op when the body already carries a marker', () => {
    const body = 'Reported bug.\n\n<!-- houserules:entry:TEST-abc123 -->';

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
