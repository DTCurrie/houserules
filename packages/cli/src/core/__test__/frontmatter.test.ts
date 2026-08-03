import { describe, expect, it } from 'vitest';

import { frontmatterBlock, splitFrontmatter } from '../frontmatter.js';

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
