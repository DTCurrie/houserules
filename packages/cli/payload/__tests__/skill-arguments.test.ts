import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PACKAGES_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const MIN_SKILL_FILES = 15;

function unescapedPositionalRefs(body: string): string[] {
  const hits: string[] = [];
  body.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/\$\d/g)) {
      const column = match.index!;
      if (line[column - 1] === '\\') continue;
      hits.push(`${index + 1}:${column + 1} ${match[0]}`);
    }
  });
  return hits;
}

function bodyAfterFrontmatter(source: string): {
  body: string;
  offset: number;
} {
  const lines = source.split('\n');
  if (lines[0]?.trim() !== '---') return { body: source, offset: 0 };
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (close === -1) return { body: source, offset: 0 };
  return { body: lines.slice(close + 1).join('\n'), offset: close + 1 };
}

function shippedSkillFiles(): string[] {
  return readdirSync(PACKAGES_DIR).flatMap((pkg) => {
    const skillsDir = join(PACKAGES_DIR, pkg, 'payload', 'skills');
    if (!existsSync(skillsDir)) return [];
    return readdirSync(skillsDir)
      .map((skill) => join(skillsDir, skill, 'SKILL.md'))
      .filter((file) => existsSync(file));
  });
}

describe('unescapedPositionalRefs', () => {
  it('flags a bare $1 and accepts an escaped \\$1', () => {
    expect(unescapedPositionalRefs("awk '{print $1}'")).toEqual(['1:13 $1']);
    expect(unescapedPositionalRefs("awk '{print \\$1}'")).toEqual([]);
  });
});

describe('shipped skill bodies', () => {
  it('carry no unescaped positional argument reference', () => {
    const files = shippedSkillFiles();

    const offenders = files.flatMap((file) => {
      const { body, offset } = bodyAfterFrontmatter(readFileSync(file, 'utf8'));
      return unescapedPositionalRefs(body).map((hit) => {
        const [position, ref] = hit.split(' ');
        const [line, column] = position!.split(':').map(Number);
        return `${file}:${line! + offset}:${column} ${ref}`;
      });
    });

    expect(files.length).toBeGreaterThanOrEqual(MIN_SKILL_FILES);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
