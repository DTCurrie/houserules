import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyLines,
  stripCode,
  stripToProse,
} from '../markdown-segment.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../../../..', import.meta.url));

function markdownFilesUnder(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

function proseVoiceCorpus(): string[] {
  const packagesDir = join(REPO_ROOT, 'packages');
  const files: string[] = [];
  for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const kind of ['rules', 'skills', 'agents']) {
      files.push(
        ...markdownFilesUnder(join(packagesDir, pkg.name, 'payload', kind)),
      );
    }
  }
  return files;
}

function semicolonFindings(stripLine: (markdown: string) => string): number {
  let count = 0;
  for (const file of proseVoiceCorpus()) {
    const lines = stripLine(readFileSync(file, 'utf8')).split('\n');
    for (const line of lines) if (line.includes(';')) count++;
  }
  return count;
}

describe('classifyLines', () => {
  it('classifies a triple-backtick fence with a language tag as code', () => {
    const markdown = [
      'prose',
      '```ts',
      'const x = 1;',
      '```',
      'more prose',
    ].join('\n');
    expect(classifyLines(markdown)).toEqual([
      'prose',
      'code',
      'code',
      'code',
      'prose',
    ]);
  });

  it('classifies a triple-backtick fence with no language tag as code', () => {
    const markdown = ['```', 'x;', '```'].join('\n');
    expect(classifyLines(markdown)).toEqual(['code', 'code', 'code']);
  });

  it('classifies a tilde fence as code', () => {
    const markdown = ['~~~', 'x;', '~~~'].join('\n');
    expect(classifyLines(markdown)).toEqual(['code', 'code', 'code']);
  });

  it('does not close a fence of more than three backticks on a shorter run', () => {
    const markdown = ['````', 'a ``` b', '````'].join('\n');
    expect(classifyLines(markdown)).toEqual(['code', 'code', 'code']);
  });

  it('runs an unclosed fence as code to end of file', () => {
    const markdown = ['prose', '```', 'x;', 'y;'].join('\n');
    expect(classifyLines(markdown)).toEqual(['prose', 'code', 'code', 'code']);
  });

  it('classifies a four-space indented code block as code', () => {
    const markdown = ['prose', '    const x = 1;', 'more prose'].join('\n');
    expect(classifyLines(markdown)).toEqual(['prose', 'code', 'prose']);
  });

  it('classifies a blockquoted line as quoted, not prose', () => {
    const markdown = ['prose', '> a quoted bad example;', 'more prose'].join(
      '\n',
    );
    expect(classifyLines(markdown)).toEqual(['prose', 'quoted', 'prose']);
  });

  it('classifies a line inside an open fence as code even if it looks like a blockquote', () => {
    const markdown = ['```', '> not actually a quote', '```'].join('\n');
    expect(classifyLines(markdown)).toEqual(['code', 'code', 'code']);
  });
});

describe('stripCode', () => {
  it('preserves the total line count', () => {
    const markdown = ['a', '```', 'b;', '```', 'c', '> d;', 'e'].join('\n');
    expect(stripCode(markdown).split('\n').length).toBe(
      markdown.split('\n').length,
    );
  });

  it('removes a semicolon inside a fenced code block', () => {
    const markdown = [
      'prose here',
      '```ts',
      'const x = 1;',
      '```',
      'more prose',
    ].join('\n');
    expect(stripCode(markdown)).not.toContain(';');
  });

  it('removes a semicolon inside a same-line inline-code span', () => {
    const markdown = 'Run `const x = 1;` to see it.';
    expect(stripCode(markdown)).not.toContain(';');
  });

  it('removes a semicolon inside a multi-line inline-code span', () => {
    const markdown = [
      '`changeset-write.mjs now authors with @changesets/write whenever changesets is',
      'installed, so files match the version; the zero-dep writer remains as fallback.`',
    ].join('\n');
    const stripped = stripCode(markdown);
    expect(stripped).not.toContain(';');
    expect(stripped.split('\n').length).toBe(2);
  });

  it('removes a semicolon inside a double-backtick span containing a literal backtick', () => {
    const markdown = 'Use ``code with a ` backtick;`` inline.';
    expect(stripCode(markdown)).not.toContain(';');
  });

  it('removes a semicolon inside a four-space indented code block', () => {
    const markdown = ['prose', '    const x = 1;', 'more prose'].join('\n');
    expect(stripCode(markdown)).not.toContain(';');
  });

  it('leaves a blockquoted semicolon in place, since stripCode only strips code', () => {
    const markdown = '> a quoted bad example;';
    expect(stripCode(markdown)).toContain(';');
  });

  it('leaves surviving prose lines untouched', () => {
    const markdown = [
      'a plain prose line',
      '```',
      'x;',
      '```',
      'another prose line',
    ].join('\n');
    const lines = stripCode(markdown).split('\n');
    expect(lines[0]).toBe('a plain prose line');
    expect(lines[4]).toBe('another prose line');
  });
});

describe('stripToProse', () => {
  it('removes a blockquoted semicolon, unlike stripCode alone', () => {
    const markdown = '> a quoted bad example;';
    expect(stripToProse(markdown)).not.toContain(';');
  });

  it('removes a semicolon inside a fenced code block', () => {
    const markdown = ['prose here', '```ts', 'const x = 1;', '```'].join('\n');
    expect(stripToProse(markdown)).not.toContain(';');
  });

  it('preserves the total line count', () => {
    const markdown = ['a', '```', 'b;', '```', 'c', '> d;', 'e'].join('\n');
    expect(stripToProse(markdown).split('\n').length).toBe(
      markdown.split('\n').length,
    );
  });

  it('leaves a genuine prose semicolon in place, so a real violation still surfaces', () => {
    const markdown = 'This has a semicolon; it should still be flagged.';
    expect(stripToProse(markdown)).toContain(';');
  });

  it("finds zero semicolons across the prose-voice corpus that produced probe 3b's two false positives", () => {
    expect(semicolonFindings(stripToProse)).toBe(0);
  });

  it('would have found the false positives without the blockquote policy, proving the assertion above is not vacuous', () => {
    expect(semicolonFindings(stripCode)).toBeGreaterThan(0);
  });
});
