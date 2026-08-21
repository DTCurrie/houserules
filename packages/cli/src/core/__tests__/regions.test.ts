import { describe, expect, it } from 'vitest';

import { extractBody, upsertRegion } from '@houserules/api/internal';
import type { RegionSpec } from '@houserules/api';

const SPEC: RegionSpec = {
  id: 'claude-md',
  start: '<!-- houserules:claude-md start -->',
  end: '<!-- houserules:claude-md end -->',
  anchor: 'eof',
};

describe('upsertRegion', () => {
  it('creates a region containing just the block when the file does not exist', () => {
    const { content, status } = upsertRegion(null, 'body text', SPEC);
    expect(status).toBe('created');
    expect(content).toBe(`${SPEC.start}\nbody text\n${SPEC.end}\n`);
  });

  it('replaces the body between existing markers while leaving surrounding bytes byte-identical', () => {
    const before = 'prefix line one\nprefix line two\n';
    const after = '\nsuffix line one\nsuffix line two\n';
    const existing = `${before}${SPEC.start}\nold body\n${SPEC.end}${after}`;
    const { content, status } = upsertRegion(existing, 'new body', SPEC);
    expect(status).toBe('replaced');
    expect(content.startsWith(before)).toBe(true);
    expect(content.endsWith(after)).toBe(true);
    expect(content).toBe(
      `${before}${SPEC.start}\nnew body\n${SPEC.end}${after}`,
    );
  });

  it('inserts right after the first H1 when anchor is after-h1, leaving prose intact', () => {
    const spec: RegionSpec = { ...SPEC, anchor: 'after-h1' };
    const existing = '# Title\n\nSome prose that must survive.\n';
    const { content, status } = upsertRegion(existing, 'body', spec);
    expect(status).toBe('inserted');
    expect(content).toContain('Some prose that must survive.');
    const lines = content.split('\n');
    expect(lines[0]).toBe('# Title');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe(spec.start);
  });

  it('inserts at end of file when anchor is eof, leaving prose intact', () => {
    const existing = 'Just some prose.\nMore prose.\n';
    const { content, status } = upsertRegion(existing, 'body', SPEC);
    expect(status).toBe('inserted');
    expect(content.startsWith(existing)).toBe(true);
    expect(content).toContain(SPEC.start);
    expect(content).toContain(SPEC.end);
  });

  it('falls back to end of file when anchor is after-h1 but no H1 is present', () => {
    const spec: RegionSpec = { ...SPEC, anchor: 'after-h1' };
    const existing = 'No heading here, just prose.\n';
    const { content, status } = upsertRegion(existing, 'body', spec);
    expect(status).toBe('inserted');
    expect(content.startsWith(existing)).toBe(true);
    expect(content).toContain(spec.start);
  });

  it('surrounds the body with blank lines inside markers when pad is true', () => {
    const padded: RegionSpec = { ...SPEC, pad: true };
    const { content } = upsertRegion(null, 'body', padded);
    expect(content).toBe(`${SPEC.start}\n\nbody\n\n${SPEC.end}\n`);
  });

  it('keeps the block tight against markers when pad is false (default)', () => {
    const { content } = upsertRegion(null, 'body', SPEC);
    expect(content).toBe(`${SPEC.start}\nbody\n${SPEC.end}\n`);
  });

  it('is idempotent for the same body', () => {
    const first = upsertRegion(null, 'stable body', SPEC);
    const second = upsertRegion(first.content, 'stable body', SPEC);
    expect(second.status).toBe('replaced');
    expect(second.content).toBe(first.content);
  });

  it('preserves a body containing marker-like text unchanged on read-back', () => {
    const trickyBody = `looks like a marker: ${SPEC.start} but is inside the body`;
    const { content } = upsertRegion(null, trickyBody, SPEC);
    expect(extractBody(content, SPEC)).toBe(trickyBody);
  });

  it('still locates the real markers to replace on the next call, after a body containing marker-like text', () => {
    const trickyBody = `looks like a marker: ${SPEC.start} but is inside the body`;
    const { content } = upsertRegion(null, trickyBody, SPEC);
    const replaced = upsertRegion(content, 'clean body', SPEC);
    expect(replaced.status).toBe('replaced');
    expect(extractBody(replaced.content, SPEC)).toBe('clean body');
  });
});

describe('upsertRegion, with a legacy marker pair', () => {
  const LEGACY_SPEC: RegionSpec = {
    ...SPEC,
    legacy: {
      start: '<!-- claude-kit:claude-md start -->',
      end: '<!-- claude-kit:claude-md end -->',
    },
  };

  it('replaces a block found only under the legacy markers rather than inserting a second block', () => {
    const before = 'prefix line one\nprefix line two\n';
    const after = '\nsuffix line one\nsuffix line two\n';
    const existing = `${before}${LEGACY_SPEC.legacy!.start}\nold body\n${LEGACY_SPEC.legacy!.end}${after}`;
    const { content, status } = upsertRegion(existing, 'new body', LEGACY_SPEC);
    expect(status).toBe('replaced');
    expect(content).toBe(
      `${before}${LEGACY_SPEC.start}\nnew body\n${LEGACY_SPEC.end}${after}`,
    );
  });

  it('emits only the current markers, never the legacy ones, once adopted', () => {
    const existing = `${LEGACY_SPEC.legacy!.start}\nold body\n${LEGACY_SPEC.legacy!.end}\n`;
    const { content } = upsertRegion(existing, 'new body', LEGACY_SPEC);
    expect(content).not.toContain(LEGACY_SPEC.legacy!.start);
    expect(content).not.toContain(LEGACY_SPEC.legacy!.end);
  });

  it('leaves a file already on the current markers unaffected by the legacy fallback', () => {
    const existing = `${LEGACY_SPEC.start}\nold body\n${LEGACY_SPEC.end}\n`;
    const { content, status } = upsertRegion(existing, 'new body', LEGACY_SPEC);
    expect(status).toBe('replaced');
    expect(content).toBe(
      `${LEGACY_SPEC.start}\nnew body\n${LEGACY_SPEC.end}\n`,
    );
  });

  it('inserts exactly once when the file carries neither the current nor the legacy markers', () => {
    const existing = 'Just some prose.\n';
    const { content, status } = upsertRegion(existing, 'body', LEGACY_SPEC);
    expect(status).toBe('inserted');
    const starts = content.match(new RegExp(LEGACY_SPEC.start, 'g')) ?? [];
    expect(starts).toHaveLength(1);
  });
});

describe('extractBody', () => {
  it('returns null when the end marker is missing (half-open)', () => {
    const halfOpen = `some text\n${SPEC.start}\nbody\n`;
    expect(extractBody(halfOpen, SPEC)).toBeNull();
  });

  it('returns null when both markers are absent', () => {
    expect(extractBody('no markers at all', SPEC)).toBeNull();
  });

  it('returns the exact body between markers', () => {
    const content = `pre\n${SPEC.start}\nline one\nline two\n${SPEC.end}\npost`;
    expect(extractBody(content, SPEC)).toBe('line one\nline two');
  });
});
