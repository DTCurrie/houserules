import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

import { commentsOf, findBritishSpellings } from '../prose-lint.mjs';

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

describe('prose-lint.mjs over a source file', () => {
  it('reads only the comments, so statements, interface bodies, and imports carry no findings', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'src/tool.mts',
      [
        '#!/usr/bin/env node',
        '/**',
        ' * Reads the config once and never again.',
        ' */',
        "import { readFileSync } from 'node:fs';",
        '',
        'interface Options {',
        '  verbose: boolean;',
        '  root: string;',
        '}',
        'const URL_RE = /https?:\\/\\/\\S+/g;',
        "const banner = 'see https://example.test/a;b'; // the URL keeps its semicolon",
        'export function run(options: Options): void {',
        '  const x = options.root; const y = options.verbose;',
        '}',
        '',
      ].join('\n'),
    );

    const r = lint(root, rel);

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain('No findings.');
  });

  it('flags a semicolon inside a line comment and inside a block comment, naming each line', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'src/tool.mts',
      [
        '/**',
        ' * Reads the config; caches it.',
        ' */',
        'const cache = new Map();',
        'const limit = 4; // a limit; not a typo',
        '',
      ].join('\n'),
    );

    const r = lint(root, rel);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${rel}:2`);
    expect(r.stdout).toContain(`${rel}:5`);
    expect(r.stdout).not.toContain(`${rel}:4`);
  });

  it('ends an em-dash paragraph at a bare star line inside a block comment', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'src/tool.mts',
      [
        '/**',
        ' * One aside — here.',
        ' *',
        ' * Another aside — there.',
        ' */',
        'export const x = 1;',
        '',
      ].join('\n'),
    );

    const r = lint(root, rel);

    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).not.toContain('[prose-voice/em-dash-density]');
  });

  it('flags a British spelling in a comment and not in an identifier', () => {
    const root = stage();
    const rel = writeMarkdown(
      root,
      'src/tool.mts',
      [
        '// Picks the colour of the badge.',
        'export const colourOf = (badge: string): string => badge;',
        '',
      ].join('\n'),
    );

    const r = lint(root, rel);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`${rel}:1`);
    expect(r.stdout).not.toContain(`${rel}:2`);
  });
});

describe('commentsOf', () => {
  it('keeps the line count of the source so findings map back to it', () => {
    const source =
      'const a = 1; // one\n/* two\n   three */ const b = 2;\nconst c = `x;\ny`;\n';

    expect(commentsOf(source).split('\n').length).toBe(
      source.split('\n').length,
    );
  });

  it('does not open a comment on an escaped slash pair inside a regex literal', () => {
    expect(commentsOf('const re = /https?:\\/\\/\\S+/g; // tail\n')).toBe(
      'tail\n',
    );
  });

  it('does not open a comment on a double slash inside a string', () => {
    expect(commentsOf("const url = 'https://x.test'; // tail\n")).toBe(
      'tail\n',
    );
  });

  it('skips a quote inside a regex literal instead of opening a string', () => {
    expect(commentsOf("const q = /'/g; // tail\n")).toBe('tail\n');
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
