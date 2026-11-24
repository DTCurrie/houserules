import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  heldIds,
  holdsPath,
  mergeHolds,
  readHolds,
  releaseHold,
  writeHolds,
} from '../sync-holds.mjs';

describe('mergeHolds', () => {
  it('adds a new hold and keeps every hold already recorded', () => {
    const holds = {
      held: { 'HOUSERULES-aaaaaa': '2026-11-24T09:00:00.000Z' },
      released: {},
    };

    const merged = mergeHolds(holds, [
      { id: 'HOUSERULES-bbbbbb', ts: '2026-11-24T10:00:00.000Z' },
    ]);

    expect(merged.held).toEqual({
      'HOUSERULES-aaaaaa': '2026-11-24T09:00:00.000Z',
      'HOUSERULES-bbbbbb': '2026-11-24T10:00:00.000Z',
    });
  });

  it('keeps the newest row ts per held id', () => {
    const merged = mergeHolds({ held: {}, released: {} }, [
      { id: 'HOUSERULES-aaaaaa', ts: '2026-11-24T10:05:00.000Z' },
      { id: 'HOUSERULES-aaaaaa', ts: '2026-11-24T10:01:00.000Z' },
    ]);

    expect(merged.held).toEqual({
      'HOUSERULES-aaaaaa': '2026-11-24T10:05:00.000Z',
    });
  });

  it('does not hold again a row its release already covered, as a second SessionEnd after /resume would', () => {
    const holds = {
      held: {},
      released: { 'HOUSERULES-aaaaaa': '2026-11-24T10:05:00.000Z' },
    };

    const merged = mergeHolds(holds, [
      { id: 'HOUSERULES-aaaaaa', ts: '2026-11-24T10:05:00.000Z' },
    ]);

    expect(merged.held).toEqual({});
  });

  it('holds a row written after the release of its id', () => {
    const holds = {
      held: {},
      released: { 'HOUSERULES-aaaaaa': '2026-11-24T10:05:00.000Z' },
    };

    const merged = mergeHolds(holds, [
      { id: 'HOUSERULES-aaaaaa', ts: '2026-11-24T11:00:00.000Z' },
    ]);

    expect(merged.held).toEqual({
      'HOUSERULES-aaaaaa': '2026-11-24T11:00:00.000Z',
    });
  });
});

describe('releaseHold', () => {
  it('moves the id from held to released, keeping its ts', () => {
    const holds = {
      held: {
        'HOUSERULES-aaaaaa': '2026-11-24T10:05:00.000Z',
        'HOUSERULES-bbbbbb': '2026-11-24T10:06:00.000Z',
      },
      released: {},
    };

    expect(releaseHold(holds, 'HOUSERULES-aaaaaa')).toEqual({
      held: { 'HOUSERULES-bbbbbb': '2026-11-24T10:06:00.000Z' },
      released: { 'HOUSERULES-aaaaaa': '2026-11-24T10:05:00.000Z' },
    });
  });

  it('returns null for an id that is not held', () => {
    expect(
      releaseHold({ held: {}, released: {} }, 'HOUSERULES-aaaaaa'),
    ).toBeNull();
  });
});

describe('heldIds', () => {
  it('lists the held ids and none of the released ones', () => {
    const ids = heldIds({
      held: { 'HOUSERULES-aaaaaa': '2026-11-24T10:05:00.000Z' },
      released: { 'HOUSERULES-bbbbbb': '2026-11-24T10:06:00.000Z' },
    });

    expect([...ids]).toEqual(['HOUSERULES-aaaaaa']);
  });
});

describe('readHolds and writeHolds', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sync-holds-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads back what was written, creating .claude/state on the way', () => {
    const holds = {
      held: { 'HOUSERULES-aaaaaa': '2026-11-24T10:05:00.000Z' },
      released: { 'HOUSERULES-bbbbbb': '2026-11-24T10:06:00.000Z' },
    };

    writeHolds(holdsPath(root), holds);

    expect(readHolds(holdsPath(root))).toEqual(holds);
  });

  it('reads no holds from a missing file', () => {
    expect(readHolds(holdsPath(root))).toEqual({ held: {}, released: {} });
  });

  it('reads no holds from a malformed file', () => {
    const path = join(root, 'holds.json');
    writeFileSync(path, '{"held": ');

    expect(readHolds(path)).toEqual({ held: {}, released: {} });
  });

  it('drops a non-string value rather than trusting the file', () => {
    const path = join(root, 'holds.json');
    writeFileSync(
      path,
      JSON.stringify({
        held: { 'HOUSERULES-aaaaaa': 7, 'HOUSERULES-bbbbbb': 'x' },
      }),
    );

    expect(readHolds(path)).toEqual({
      held: { 'HOUSERULES-bbbbbb': 'x' },
      released: {},
    });
  });
});
