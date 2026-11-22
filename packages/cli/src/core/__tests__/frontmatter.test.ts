import { describe, expect, it } from 'vitest';

import {
  frontmatterBlock,
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
