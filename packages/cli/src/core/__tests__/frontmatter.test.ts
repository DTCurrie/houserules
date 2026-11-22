import { describe, expect, it } from 'vitest';

import {
  frontmatterBlock,
  parseFrontmatterPaths,
  renderFrontmatterPaths,
  splitFrontmatter,
} from '../frontmatter.js';

describe('splitFrontmatter', () => {
  it('concatenates the two halves back to the input byte for byte', () => {
    const input = '---\ndescription: a rule\n---\nbody text\n';

    const { frontmatter, body } = splitFrontmatter(input);

    expect(frontmatter + body).toBe(input);
  });

  it('treats a file with no frontmatter as all body with an empty frontmatter', () => {
    const input = '# just a heading\nbody text\n';

    expect(splitFrontmatter(input)).toEqual({ frontmatter: '', body: input });
  });

  it('does not end the block at a --- divider later in the body', () => {
    const input = '---\ndescription: a rule\n---\nfirst\n---\nsecond\n';

    const { frontmatter, body } = splitFrontmatter(input);

    expect(frontmatter).toBe('---\ndescription: a rule\n---\n');
    expect(body).toBe('first\n---\nsecond\n');
  });

  it('handles an empty body after the closing delimiter', () => {
    const input = '---\ndescription: a rule\n---\n';

    expect(splitFrontmatter(input)).toEqual({
      frontmatter: input,
      body: '',
    });
  });
});

describe('frontmatterBlock', () => {
  it('returns the text between the delimiters', () => {
    expect(frontmatterBlock('---\ndescription: a rule\n---\nbody text\n')).toBe(
      'description: a rule',
    );
  });

  it('returns null when there is no frontmatter', () => {
    expect(frontmatterBlock('# just a heading\nbody text\n')).toBeNull();
  });
});

describe('renderFrontmatterPaths', () => {
  it('replaces a shipped paths list in the shape shipped rules write it', () => {
    const shipped = "---\npaths:\n  - '**/*.ts'\n  - '**/*.tsx'\n---\n";

    expect(renderFrontmatterPaths(shipped, ['src/**/*.ts'])).toBe(
      "---\npaths:\n  - 'src/**/*.ts'\n---\n",
    );
  });

  it('keeps every other key byte for byte, around and after the replaced list', () => {
    const shipped =
      '---\ndescription:  "Spaced  value"  # note\npaths:\n  - \'**/*.ts\'\nalwaysApply: false\nnested:\n    deep: [1, 2]\n---\n';

    expect(renderFrontmatterPaths(shipped, ['lib/**', 'app/**'])).toBe(
      "---\ndescription:  \"Spaced  value\"  # note\npaths:\n  - 'lib/**'\n  - 'app/**'\nalwaysApply: false\nnested:\n    deep: [1, 2]\n---\n",
    );
  });

  it('replaces a block list written flush with its key and an inline list alike', () => {
    expect(
      renderFrontmatterPaths(
        '---\npaths:\n- "a/**"\n- "b/**"\nname: x\n---\n',
        ['c/**'],
      ),
    ).toBe("---\npaths:\n  - 'c/**'\nname: x\n---\n");
    expect(
      renderFrontmatterPaths('---\npaths: ["a/**"]\nname: x\n---\n', ['c/**']),
    ).toBe("---\npaths:\n  - 'c/**'\nname: x\n---\n");
  });

  it('appends the key below the other keys when the frontmatter has none', () => {
    expect(
      renderFrontmatterPaths('---\ndescription: a rule\n---\n', ['src/**']),
    ).toBe("---\ndescription: a rule\npaths:\n  - 'src/**'\n---\n");
  });

  it('adds a block holding only the key when the file has no frontmatter', () => {
    expect(renderFrontmatterPaths('', ['src/**'])).toBe(
      "---\npaths:\n  - 'src/**'\n---\n",
    );
  });

  it('doubles a single quote inside a glob, as YAML single quoting requires', () => {
    expect(renderFrontmatterPaths('', ["it's/**"])).toBe(
      "---\npaths:\n  - 'it''s/**'\n---\n",
    );
  });

  it('writes an empty list inline', () => {
    expect(renderFrontmatterPaths("---\npaths:\n  - 'a/**'\n---\n", [])).toBe(
      '---\npaths: []\n---\n',
    );
  });

  it('keeps CRLF line endings on every line, the rendered ones included', () => {
    const shipped = "---\r\nname: x\r\npaths:\r\n  - 'a/**'\r\n---\r\n";

    expect(renderFrontmatterPaths(shipped, ['b/**', 'c/**'])).toBe(
      "---\r\nname: x\r\npaths:\r\n  - 'b/**'\r\n  - 'c/**'\r\n---\r\n",
    );
  });

  it('appends under CRLF without merging into the last key', () => {
    expect(renderFrontmatterPaths('---\r\nname: x\r\n---\r\n', ['b/**'])).toBe(
      "---\r\nname: x\r\npaths:\r\n  - 'b/**'\r\n---\r\n",
    );
  });

  it('is stable when rendered over its own output', () => {
    const once = renderFrontmatterPaths('---\ndescription: a rule\n---\n', [
      'src/**',
    ]);

    expect(renderFrontmatterPaths(once, ['src/**'])).toBe(once);
  });
});

describe('parseFrontmatterPaths', () => {
  it.each([
    {
      shape: 'an inline empty list',
      input: '---\npaths: []\n---\n',
      expected: [],
    },
    {
      shape: 'single-quoted items with a doubled quote',
      input: "---\npaths:\n  - 'src/**'\n  - 'it''s/*.md'\n---\n",
      expected: ['src/**', "it's/*.md"],
    },
    {
      shape: 'double-quoted items with an escaped quote',
      input: '---\npaths:\n  - "a/**"\n  - "b\\"c"\n---\n',
      expected: ['a/**', 'b"c'],
    },
    {
      shape: 'bare items written flush with the key',
      input: '---\npaths:\n- src/**/*.ts\n- lib/*.js\n---\n',
      expected: ['src/**/*.ts', 'lib/*.js'],
    },
    {
      shape: 'a list between other keys',
      input: "---\nname: x\npaths:\n  - 'a/**'\nalwaysApply: false\n---\n",
      expected: ['a/**'],
    },
    {
      shape: 'CRLF line endings',
      input: "---\r\npaths:\r\n  - 'a/**'\r\n  - 'b/**'\r\n---\r\n",
      expected: ['a/**', 'b/**'],
    },
  ])('reads $shape', ({ input, expected }) => {
    expect(parseFrontmatterPaths(input)).toEqual(expected);
  });

  it.each([
    { shape: 'no frontmatter', input: '' },
    { shape: 'no paths: key', input: '---\nname: x\n---\n' },
    { shape: 'an inline flow list', input: '---\npaths: ["a/**"]\n---\n' },
    { shape: 'a scalar value', input: '---\npaths: src/**\n---\n' },
    { shape: 'a key with no items', input: '---\npaths:\nname: x\n---\n' },
    {
      shape: 'a nested mapping under the key',
      input: '---\npaths:\n  glob: a/**\n---\n',
    },
    {
      shape: 'a bare item with a trailing comment',
      input: '---\npaths:\n  - a/** # mine\n---\n',
    },
    {
      shape: 'an unterminated quoted item',
      input: "---\npaths:\n  - 'a/**\n---\n",
    },
  ])('returns null for $shape', ({ input }) => {
    expect(parseFrontmatterPaths(input)).toBeNull();
  });

  it('round-trips the paths renderFrontmatterPaths writes', () => {
    const paths = ['src/**/*.ts', "it's/**", 'a b/*.md'];

    const rendered = renderFrontmatterPaths(
      '---\ndescription: a rule\n---\n',
      paths,
    );

    expect(parseFrontmatterPaths(rendered)).toEqual([
      'src/**/*.ts',
      "it's/**",
      'a b/*.md',
    ]);
  });

  it('round-trips an empty list', () => {
    expect(
      parseFrontmatterPaths(renderFrontmatterPaths('---\nname: x\n---\n', [])),
    ).toEqual([]);
  });
});
