import { expect, test } from 'vitest';

import {
  extractBody,
  upsertRegion,
  type RegionSpec,
} from '../src/core/regions.js';

const SPEC: RegionSpec = {
  id: 'claude-md',
  start: '<!-- claude-kit:claude-md start -->',
  end: '<!-- claude-kit:claude-md end -->',
  anchor: 'eof',
};

test('RG1: missing file creates a region containing just the block', () => {
  const { content, status } = upsertRegion(null, 'body text', SPEC);
  expect(status).toBe('created');
  expect(content).toBe(`${SPEC.start}\nbody text\n${SPEC.end}\n`);
});

test('RG2: existing markers replace body; surrounding bytes are byte-identical', () => {
  const before = 'prefix line one\nprefix line two\n';
  const after = '\nsuffix line one\nsuffix line two\n';
  const existing = `${before}${SPEC.start}\nold body\n${SPEC.end}${after}`;
  const { content, status } = upsertRegion(existing, 'new body', SPEC);
  expect(status).toBe('replaced');
  expect(content.startsWith(before)).toBe(true);
  expect(content.endsWith(after)).toBe(true);
  expect(content).toBe(`${before}${SPEC.start}\nnew body\n${SPEC.end}${after}`);
});

test('RG3: anchor after-h1 inserts right after the first H1, prose intact', () => {
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

test('RG4: anchor eof inserts at end of file, prose intact', () => {
  const existing = 'Just some prose.\nMore prose.\n';
  const { content, status } = upsertRegion(existing, 'body', SPEC);
  expect(status).toBe('inserted');
  expect(content.startsWith(existing)).toBe(true);
  expect(content).toContain(SPEC.start);
  expect(content).toContain(SPEC.end);
});

test('RG5: after-h1 with no H1 present falls back to end of file', () => {
  const spec: RegionSpec = { ...SPEC, anchor: 'after-h1' };
  const existing = 'No heading here, just prose.\n';
  const { content, status } = upsertRegion(existing, 'body', spec);
  expect(status).toBe('inserted');
  expect(content.startsWith(existing)).toBe(true);
  expect(content).toContain(spec.start);
});

test('RG6: extractBody returns null when the end marker is missing (half-open)', () => {
  const halfOpen = `some text\n${SPEC.start}\nbody\n`;
  expect(extractBody(halfOpen, SPEC)).toBeNull();
});

test('RG7: extractBody returns null when both markers are absent', () => {
  expect(extractBody('no markers at all', SPEC)).toBeNull();
});

test('RG8: extractBody returns the exact body between markers', () => {
  const content = `pre\n${SPEC.start}\nline one\nline two\n${SPEC.end}\npost`;
  expect(extractBody(content, SPEC)).toBe('line one\nline two');
});

test('RG9: pad true surrounds the body with blank lines inside markers', () => {
  const padded: RegionSpec = { ...SPEC, pad: true };
  const { content } = upsertRegion(null, 'body', padded);
  expect(content).toBe(`${SPEC.start}\n\nbody\n\n${SPEC.end}\n`);
});

test('RG10: pad false (default) keeps the block tight against markers', () => {
  const { content } = upsertRegion(null, 'body', SPEC);
  expect(content).toBe(`${SPEC.start}\nbody\n${SPEC.end}\n`);
});

test('RG11: upsertRegion is idempotent for the same body', () => {
  const first = upsertRegion(null, 'stable body', SPEC);
  const second = upsertRegion(first.content, 'stable body', SPEC);
  expect(second.status).toBe('replaced');
  expect(second.content).toBe(first.content);
});

test('RG12: a body containing marker-like text does not corrupt the parse', () => {
  const trickyBody = `looks like a marker: ${SPEC.start} but is inside the body`;
  const { content } = upsertRegion(null, trickyBody, SPEC);
  expect(extractBody(content, SPEC)).toBe(trickyBody);

  const replaced = upsertRegion(content, 'clean body', SPEC);
  expect(replaced.status).toBe('replaced');
  expect(extractBody(replaced.content, SPEC)).toBe('clean body');
});
