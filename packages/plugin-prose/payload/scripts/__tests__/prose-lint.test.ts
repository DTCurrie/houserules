import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

import { findBritishSpellings } from '../prose-lint.mjs';

const LINT = '.claude/scripts/prose-lint.mjs';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));

function stage(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'prose/prose-voice',
    plugins: [{ name: PLUGIN_DIR, alias: 'prose' }],
  });
}

function writeMarkdown(root: string, rel: string, body: string): string {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
  return rel;
}

function lint(root: string, ...rel: string[]) {
  return runScript(root, LINT, { args: rel });
}

describe('prose-lint.mjs no-semicolons', () => {
  it('exits 0 and reports no findings for prose with no semicolon', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'doc.md',
      'Plain sentences only. No joins here.\n',
    );

    const r = lint(root, rel);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('No findings.');
  });

  it('flags a semicolon in prose, naming the file and line', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'doc.md',
      'First line is fine.\nA clause; a second clause.\n',
    );

    const r = lint(root, rel);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${rel}:2`);
    expect(r.stdout).toContain('[prose-voice/no-semicolons]');
  });

  it('does not flag a semicolon inside a blockquoted example the document quotes to forbid it', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'doc.md',
      '> Bad example: a clause; a second clause.\n\nRewritten without one.\n',
    );

    const r = lint(root, rel);

    expect(r.status, r.stdout).toBe(0);
  });
});

describe('prose-lint.mjs em-dash density', () => {
  it('warns once, without failing, on a single em dash in a paragraph', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'doc.md',
      'One aside — kept because nothing else carries it.\n',
    );

    const r = lint(root, rel);

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('[prose-voice/em-dash-present]');
    expect(r.stdout).not.toContain('em-dash-density');
  });

  it('errors when a single paragraph carries two or more em dashes', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'doc.md',
      'One aside — and another aside — stacked in one paragraph.\n',
    );

    const r = lint(root, rel);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[prose-voice/em-dash-density]');
  });

  it('does not carry an em-dash count across a paragraph break', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'doc.md',
      'One aside — kept on its own.\n\nAnother aside — kept on its own too.\n',
    );

    const r = lint(root, rel);

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toContain('em-dash-density');
  });
});

describe('prose-lint.mjs american-english', () => {
  it('flags a British spelling, naming the file, line, and American form', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'doc.md',
      'First line is fine.\nThe colour of the label.\n',
    );

    const r = lint(root, rel);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${rel}:2`);
    expect(r.stdout).toContain('[prose-voice/american-english]');
    expect(r.stdout).toContain('British spelling "colour". Write "color".');
  });

  it('does not flag a British spelling inside an inline code span', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'doc.md',
      'Pass `colour` to the option, since that is its name.\n',
    );

    const r = lint(root, rel);

    expect(r.status, r.stdout).toBe(0);
  });

  it('does not flag a British spelling inside a URL', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'doc.md',
      'See https://example.com/docs/colour-theory for the palette.\n',
    );

    const r = lint(root, rel);

    expect(r.status, r.stdout).toBe(0);
  });
});

describe('findBritishSpellings', () => {
  it.each([
    ['behaviour', 'behavior'],
    ['Behavioural', 'Behavioral'],
    ['colourful', 'colorful'],
    ['organisation', 'organization'],
    ['Organisational', 'Organizational'],
    ['recognised', 'recognized'],
    ['serialiser', 'serializer'],
    ['visualised', 'visualized'],
    ['disorganised', 'disorganized'],
    ['analysed', 'analyzed'],
    ['kilometres', 'kilometers'],
    ['centre', 'center'],
    ['labelled', 'labeled'],
    ['modelling', 'modeling'],
    ['counsellor', 'counselor'],
    ['licence', 'license'],
    ['Grey', 'Gray'],
    ['artefacts', 'artifacts'],
    ['whilst', 'while'],
    ['catalogued', 'cataloged'],
  ])('maps %s to %s', (british, american) => {
    expect(findBritishSpellings(`One ${british} here.`)).toEqual([
      { word: british, american },
    ]);
  });

  it.each([
    'advertise',
    'compromise',
    'exercise',
    'promise',
    'enterprise',
    'analyses',
    'characteristic',
    'organism',
    'glamour',
    'contour',
    'cancellation',
    'totally',
    'programmer',
    'utilities',
  ])('leaves the American word %s alone', (word) => {
    expect(findBritishSpellings(`One ${word} here.`)).toEqual([]);
  });

  it('reports every hit on a line in order', () => {
    expect(
      findBritishSpellings('A grey colour, analysed and labelled.'),
    ).toEqual([
      { word: 'grey', american: 'gray' },
      { word: 'colour', american: 'color' },
      { word: 'analysed', american: 'analyzed' },
      { word: 'labelled', american: 'labeled' },
    ]);
  });
});

describe('prose-lint.mjs given a file it cannot read', () => {
  it('exits 0 and reports no findings rather than crashing', () => {
    const root = stage();

    const r = lint(root, 'missing.md');

    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('No findings.');
  });
});
