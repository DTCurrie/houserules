import { describe, expect, it } from 'vitest';

import {
  checkPathWatchableScope,
  checkRequiredFields,
} from '../decision-lint.mjs';

const FILE = '.claude/ledgers/DECISIONS.md';

function entry(
  body: string,
  opts: { id?: string; scope?: string; status?: string } = {},
): string {
  const id = opts.id ?? 'CORE-abc123';
  const scopeLine = opts.scope ? `**Scope:** ${opts.scope}\n` : '';
  const status = opts.status ?? 'accepted';
  return [
    `## [${id}] A decision`,
    '',
    `**Decided:** 2026-08-18 · **Status:** ${status}`,
    scopeLine,
    body,
    '',
    '---',
    '',
  ].join('\n');
}

describe('checkRequiredFields', () => {
  it('reports nothing when a record carries both fields', () => {
    const markdown = entry(
      [
        'Why. Some reasoning here.',
        '',
        'Rejected: an alternative that was considered and passed over.',
        '',
        'Revisit when the assumption stops holding.',
      ].join('\n'),
    );
    const report = checkRequiredFields(FILE, markdown);
    expect(report.findings).toEqual([]);
  });

  it('flags a record missing the Rejected field', () => {
    const markdown = entry(
      [
        'Why. Some reasoning here.',
        '',
        'Revisit when the assumption stops holding.',
      ].join('\n'),
    );
    const report = checkRequiredFields(FILE, markdown);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('decide/required-fields');
    expect(report.findings[0]?.level).toBe('error');
    expect(report.findings[0]?.msg).toContain('Rejected');
  });

  it('flags a record missing the Revisit field', () => {
    const markdown = entry(
      [
        'Why. Some reasoning here.',
        '',
        'Rejected: an alternative that was considered and passed over.',
      ].join('\n'),
    );
    const report = checkRequiredFields(FILE, markdown);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.msg).toContain('Revisit');
  });

  it('recognizes a bolded metadata-style field label', () => {
    const markdown = entry(
      [
        '**Rejected:** an alternative that was considered and passed over.',
        '',
        '**Revisit when:** the assumption stops holding.',
      ].join('\n'),
    );
    const report = checkRequiredFields(FILE, markdown);
    expect(report.findings).toEqual([]);
  });

  it('does not match the words mid-sentence in an unrelated paragraph', () => {
    const markdown = entry(
      [
        'Its own revisit trigger already fired, but nobody noticed because the check that',
        'would have caught it was the broken one.',
      ].join('\n'),
    );
    const report = checkRequiredFields(FILE, markdown);
    expect(report.findings).toHaveLength(2);
  });

  it('skips a superseded record, whose supersessor owes the fields', () => {
    const markdown = entry('The body carries neither field.', {
      status: 'superseded',
    });

    const report = checkRequiredFields(FILE, markdown);

    expect(report.findings).toHaveLength(0);
  });
});

describe('checkPathWatchableScope', () => {
  it('reports nothing when the revisit trigger names no path', () => {
    const markdown = entry(
      'Revisit when the underlying library ships a stable v2.',
      { scope: '`packages/cli/src`' },
    );
    const report = checkPathWatchableScope(FILE, markdown);
    expect(report.findings).toEqual([]);
  });

  it('reports nothing when the named path is already in scope', () => {
    const markdown = entry(
      'Revisit when `packages/cli/src/commands/init.ts` changes shape.',
      { scope: '`packages/cli/src/commands/init.ts`' },
    );
    const report = checkPathWatchableScope(FILE, markdown);
    expect(report.findings).toEqual([]);
  });

  it('skips a superseded record even when its trigger names an unscoped path', () => {
    const markdown = entry(
      'Revisit when `packages/cli/src/commands/init.ts` changes shape.',
      { scope: '`packages/api/src/ctx.ts`', status: 'superseded' },
    );

    const report = checkPathWatchableScope(FILE, markdown);

    expect(report.findings).toHaveLength(0);
  });

  it('flags a path named in the revisit trigger that scope does not cover', () => {
    const markdown = entry(
      'Revisit when `packages/cli/src/commands/init.ts` changes shape.',
      { scope: '`packages/api/src/ctx.ts`' },
    );
    const report = checkPathWatchableScope(FILE, markdown);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.level).toBe('warn');
    expect(report.findings[0]?.rule).toBe('decide/path-watchable-scope');
    expect(report.findings[0]?.msg).toContain(
      'packages/cli/src/commands/init.ts',
    );
  });

  it('ignores a path-shaped token outside the revisit paragraph', () => {
    const markdown = entry(
      [
        'In the code. `packages/cli/src/commands/init.ts` is where this lives.',
        '',
        'Revisit when the library ships a stable v2.',
      ].join('\n'),
      { scope: '' },
    );
    const report = checkPathWatchableScope(FILE, markdown);
    expect(report.findings).toEqual([]);
  });
});
