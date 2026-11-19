import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { findDuplicateIds, scaffoldSynthesis } from '../scaffold-synthesis.mjs';

const SCRIPT = fileURLToPath(
  new URL(
    '../../../payload-dist/scripts/scaffold-synthesis.mjs',
    import.meta.url,
  ),
);

const DESTINATIONS = 'phase-3,phase-4,none';

const TEMPLATE = `# Template title

Intro text that is dropped.

## Verdicts

One verdict each.

## Findings

The merged blocks.

## Open questions

Carried questions.
`;

function run(args: string[]) {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env,
  });
}

function block(
  id: string,
  title: string,
  overrides: Record<string, string> = {},
): string {
  const fields: Record<string, string> = {
    tag: 'quality',
    surface: 'none',
    evidence: 'https://example.com/a',
    'version gate': 'n/a',
    'candidate action': 'fix-now',
    destination: 'phase-3',
    cost: 'one file',
    ...overrides,
  };
  const lines = Object.entries(fields).map(
    ([key, value]) => `- **${key}:** ${value}`,
  );
  return `### ${id} ${title}\n\n${lines.join('\n')}\n`;
}

function report(prefix: string, titles: string[]): string {
  const blocks = titles.map((title, index) =>
    block(`${prefix}-${String(index + 1).padStart(2, '0')}`, title),
  );
  return `# Report ${prefix}\n\n${blocks.join('\n')}`;
}

function rowIds(output: string): string[] {
  return [...output.matchAll(/^\| ([A-Z]{2}-\d{2}) \|/gm)].map(
    (match) => match[1] as string,
  );
}

describe('scaffoldSynthesis', () => {
  it('writes one row per input id across two and three reports', () => {
    const reports = [
      { path: 'a.md', text: report('AA', ['one', 'two', 'three']) },
      { path: 'b.md', text: report('BB', ['four']) },
      { path: 'c.md', text: report('CC', ['five', 'six']) },
    ];
    const output = scaffoldSynthesis(reports, undefined);
    expect(rowIds(output)).toEqual([
      'AA-01',
      'AA-02',
      'AA-03',
      'BB-01',
      'CC-01',
      'CC-02',
    ]);
    expect(rowIds(scaffoldSynthesis(reports.slice(0, 2), undefined))).toEqual([
      'AA-01',
      'AA-02',
      'AA-03',
      'BB-01',
    ]);
  });

  it('writes a source reference naming the report path and id', () => {
    const output = scaffoldSynthesis(
      [{ path: 'reports/a.md', text: report('AA', ['one']) }],
      undefined,
    );
    expect(output).toContain(
      '| AA-01 | one | fix-now | phase-3 | `reports/a.md#AA-01` |',
    );
  });

  it('fills the action and destination cells from each finding in its own column', () => {
    const text = [
      block('AA-01', 'first'),
      block('AA-02', 'second', {
        'candidate action': 'backlog',
        destination: 'none',
      }),
    ].join('\n');

    const output = scaffoldSynthesis([{ path: 'a.md', text }], undefined);

    expect(output).toContain(
      '| AA-01 | first | fix-now | phase-3 | `a.md#AA-01` |',
    );
    expect(output).toContain(
      '| AA-02 | second | backlog | none | `a.md#AA-02` |',
    );
  });

  it('gives a report with zero findings no rows and keeps the others', () => {
    const output = scaffoldSynthesis(
      [
        { path: 'a.md', text: '# Report\n\nZero findings this pass.\n' },
        { path: 'b.md', text: report('BB', ['only']) },
      ],
      undefined,
    );
    expect(rowIds(output)).toEqual(['BB-01']);
  });

  it('escapes a pipe in a title and keeps the row on one line', () => {
    const output = scaffoldSynthesis(
      [{ path: 'a.md', text: report('AA', ['left | right']) }],
      undefined,
    );
    expect(output).toContain('| AA-01 | left \\| right |');
    expect(rowIds(output)).toEqual(['AA-01']);
  });

  it('leaves no carriage return in a title read from a CRLF report', () => {
    const text = report('AA', ['first title', 'second  title']).replace(
      /\n/g,
      '\r\n',
    );
    const output = scaffoldSynthesis([{ path: 'a.md', text }], undefined);
    expect(output).not.toContain('\r');
    expect(output).toContain('| AA-01 | first title |');
    expect(output).toContain('| AA-02 | second title |');
  });

  it('writes a Synthesis title and a Findings section when there is no template', () => {
    const output = scaffoldSynthesis(
      [{ path: 'a.md', text: report('AA', ['one']) }],
      undefined,
    );
    const headings = output.split('\n').filter((line) => /^#{1,2} /.test(line));
    expect(headings).toEqual(['# Synthesis', '## Findings']);
    expect(output).toContain('No findings are merged yet.');
  });

  it('keeps the template headings in order and puts the table under Findings', () => {
    const output = scaffoldSynthesis(
      [{ path: 'a.md', text: report('AA', ['one']) }],
      TEMPLATE,
    );
    const headings = output.split('\n').filter((line) => /^#{1,2} /.test(line));
    expect(headings).toEqual([
      '# Synthesis',
      '## Verdicts',
      '## Findings',
      '## Open questions',
    ]);
    expect(output).not.toContain('Intro text that is dropped');
    expect(output).toContain('One verdict each.');
    expect(output).toMatch(/## Findings\n\n\| id \| title \|/);
    expect(output.indexOf('| AA-01 |')).toBeLessThan(
      output.indexOf('## Open questions'),
    );
  });

  it('appends a Findings section when the template has none', () => {
    const output = scaffoldSynthesis(
      [{ path: 'a.md', text: report('AA', ['one']) }],
      '## Verdicts\n\nText.\n',
    );
    const headings = output.split('\n').filter((line) => /^#{1,2} /.test(line));
    expect(headings).toEqual(['# Synthesis', '## Verdicts', '## Findings']);
  });
});

describe('findDuplicateIds', () => {
  it('names the id and both paths when two reports share one', () => {
    const duplicates = findDuplicateIds([
      { path: 'a.md', text: report('AA', ['one', 'two']) },
      { path: 'b.md', text: report('AA', ['three']) },
    ]);
    expect(duplicates).toEqual([{ id: 'AA-01', paths: ['a.md', 'b.md'] }]);
  });

  it('returns nothing when every id is unique', () => {
    expect(
      findDuplicateIds([
        { path: 'a.md', text: report('AA', ['one']) },
        { path: 'b.md', text: report('BB', ['two']) },
      ]),
    ).toEqual([]);
  });
});

describe('scaffold-synthesis.mjs (real execution)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'scaffold-synthesis-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  }

  it('prints a skeleton with one row per id and exits 0', () => {
    const firstReport = write('a.md', report('AA', ['one', 'two']));
    const secondReport = write('b.md', report('BB', ['three']));
    const result = run([
      '--destinations',
      DESTINATIONS,
      firstReport,
      secondReport,
    ]);
    expect(result.status).toBe(0);
    expect(rowIds(result.stdout)).toEqual(['AA-01', 'AA-02', 'BB-01']);
    expect(result.stdout.startsWith('# Synthesis\n')).toBe(true);
  });

  it('applies the template given with --template', () => {
    const firstReport = write('a.md', report('AA', ['one']));
    const template = write('template.md', TEMPLATE);
    const result = run([
      '--destinations',
      DESTINATIONS,
      '--template',
      template,
      firstReport,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /## Verdicts[\s\S]*## Findings[\s\S]*## Open/,
    );
  });

  it('exits 1 naming the id and both paths when two reports share an id', () => {
    const firstReport = write('a.md', report('AA', ['one']));
    const secondReport = write('b.md', report('AA', ['two']));
    const result = run([
      '--destinations',
      DESTINATIONS,
      firstReport,
      secondReport,
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('AA-01');
    expect(result.stderr).toContain(firstReport);
    expect(result.stderr).toContain(secondReport);
  });

  it('exits 1 with the checker result lines when a report has a defect', () => {
    const bad = write(
      'bad.md',
      `# Report\n\n${block('AA-01', 'broken', { tag: 'mood' })}`,
    );
    const result = run(['--destinations', DESTINATIONS, bad]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`${bad}: 1 finding(s), 1 defect(s)`);
    expect(result.stderr).toContain('  AA-01: tag "mood"');
  });

  it('exits 1 when a file is unreadable', () => {
    const result = run([
      '--destinations',
      DESTINATIONS,
      join(dir, 'missing.md'),
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('missing.md');
  });

  it('exits 2 without --destinations', () => {
    const firstReport = write('a.md', report('AA', ['one']));
    expect(run([firstReport]).status).toBe(2);
  });

  it('exits 2 when no file is given', () => {
    expect(run(['--destinations', DESTINATIONS]).status).toBe(2);
  });

  it('exits 2 on an unknown option', () => {
    const firstReport = write('a.md', report('AA', ['one']));
    expect(
      run(['--destinations', DESTINATIONS, '--bogus', firstReport]).status,
    ).toBe(2);
  });

  it('exits 2 when --template has no value', () => {
    const firstReport = write('a.md', report('AA', ['one']));
    expect(
      run(['--destinations', DESTINATIONS, firstReport, '--template']).status,
    ).toBe(2);
  });
});
