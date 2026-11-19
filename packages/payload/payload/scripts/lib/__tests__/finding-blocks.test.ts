import { describe, expect, it } from 'vitest';

import {
  checkFindings,
  findingIds,
  formatFileResult,
  parseFindings,
} from '../finding-blocks.mjs';

function block(
  id: string,
  overrides: Record<string, string | null> = {},
): string {
  const fields: Record<string, string | null> = {
    tag: 'quality',
    surface: 'none',
    evidence: 'https://example.com/a → "quoted"',
    'version gate': 'n/a',
    'candidate action': 'fix-now',
    destination: 'phase-3',
    cost: 'one file',
    ...overrides,
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `- **${key}:** ${value}`);
  return `### ${id} A title\n\n${lines.join('\n')}\n`;
}

describe('parseFindings', () => {
  it('returns each block with its id, title, and fields by key', () => {
    const text = `# R\n\n${block('AB-01')}\n### AB-02 Second one\n\n- **evidence:** \`a\`\n- **evidence:** \`b\`\n`;

    const found = parseFindings(text);

    expect(found.map((item) => [item.id, item.title])).toEqual([
      ['AB-01', 'A title'],
      ['AB-02', 'Second one'],
    ]);
    expect(found[1]?.fields.get('evidence')).toEqual(['`a`', '`b`']);
    expect(found[0]?.fields.get('destination')).toEqual(['phase-3']);
  });

  it('returns nothing for text with no finding heading', () => {
    expect(parseFindings('# R\n\n### not an id\n')).toEqual([]);
  });
});

describe('findingIds', () => {
  it('lists ids in file order and skips headings that are not ids', () => {
    expect(findingIds('### AB-01 x\n### notes\n### CD-02 y\n')).toEqual([
      'AB-01',
      'CD-02',
    ]);
  });
});

describe('checkFindings', () => {
  const destinations = new Set(['phase-3', 'none']);

  it('returns no defects for a clean block', () => {
    expect(checkFindings(block('AB-01'), destinations)).toEqual([]);
  });

  it('lists block defects before numbering defects', () => {
    const text = `${block('AB-01', { tag: 'style' })}\n${block('AB-03')}`;

    expect(checkFindings(text, destinations)).toEqual([
      'AB-01: tag "style"',
      'AB-03: numbering gap, expected AB-02',
    ]);
  });

  it('truncates the evidence quote in its message to 60 characters', () => {
    const long = 'x'.repeat(80);

    expect(
      checkFindings(block('AB-01', { evidence: long }), destinations),
    ).toEqual([`AB-01: evidence has no URL and no command: ${'x'.repeat(60)}`]);
  });

  it('skips the pairing check when the destination is not in the set', () => {
    expect(
      checkFindings(block('AB-01', { destination: 'phase-9' }), destinations),
    ).toEqual(['AB-01: destination "phase-9"']);
  });
});

describe('formatFileResult', () => {
  it('prints the count line alone when there are no defects', () => {
    expect(formatFileResult('r.md', 2, [])).toBe(
      'r.md: 2 finding(s), 0 defect(s)',
    );
  });

  it('indents each defect two spaces under the count line', () => {
    expect(formatFileResult('r.md', 1, ['a', 'b'])).toBe(
      'r.md: 1 finding(s), 2 defect(s)\n  a\n  b',
    );
  });
});
