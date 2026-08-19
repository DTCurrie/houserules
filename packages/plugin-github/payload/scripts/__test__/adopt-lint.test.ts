import { describe, expect, it } from 'vitest';

import {
  checkAdoptedTitleDrift,
  checkDuplicateIssueAdoption,
  checkTargetLabelCollisions,
  checkTargetPathPrefixOverlap,
} from '../adopt-lint.mjs';
import type { AdoptRecord } from '../adopt-lint.mjs';
import type { LedgerIndex } from '@houserules/payload/ledger-index';
import type { ConfigTarget } from '@houserules/payload/config';

const FILE = '.claude/ledgers/backlog.jsonl';

function add(overrides: Partial<AdoptRecord> = {}): AdoptRecord {
  return {
    id: 'CORE-abc123',
    action: 'add',
    title: 'Fix the thing',
    issue: 42,
    ...overrides,
  };
}

function index(entries: LedgerIndex['entries']): LedgerIndex {
  return {
    version: 1,
    kind: 'backlog',
    pulledAt: '2026-08-18T00:00:00Z',
    projects: [1],
    entries,
  };
}

function indexEntry(
  overrides: Partial<LedgerIndex['entries'][number]> = {},
): LedgerIndex['entries'][number] {
  return {
    id: 'CORE-abc123',
    itemId: 'item-1',
    issue: 42,
    title: 'Fix the thing',
    body: 'triage notes',
    surface: 'BACKLOG.md',
    date: '2026-08-18',
    chat: null,
    status: null,
    scope: [],
    under: null,
    supersedes: [],
    supersededBy: null,
    ...overrides,
  };
}

function target(overrides: Partial<ConfigTarget> = {}): ConfigTarget {
  return {
    name: 'core',
    prefix: 'CORE',
    pathPrefix: 'packages/core/',
    label: 'Core',
    ...overrides,
  };
}

describe('checkDuplicateIssueAdoption', () => {
  it('reports nothing when every issue is adopted once', () => {
    const report = checkDuplicateIssueAdoption(FILE, [
      add({ id: 'CORE-a', issue: 1 }),
      add({ id: 'CORE-b', issue: 2 }),
    ]);
    expect(report.findings).toEqual([]);
  });

  it('flags two entries claiming the same issue', () => {
    const report = checkDuplicateIssueAdoption(FILE, [
      add({ id: 'CORE-a', issue: 7 }),
      add({ id: 'CORE-b', issue: 7 }),
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('backlog-adopt/duplicate-issue');
    expect(report.findings[0]?.level).toBe('error');
    expect(report.findings[0]?.msg).toContain('issue #7');
  });

  it('ignores records that are not an adopted add', () => {
    const report = checkDuplicateIssueAdoption(FILE, [
      add({ id: 'CORE-a', issue: 7 }),
      { id: 'CORE-a', action: 'move' },
      add({ id: 'CORE-c' }),
    ]);
    expect(report.findings).toEqual([]);
  });
});

describe('checkAdoptedTitleDrift', () => {
  it('reports nothing when the recorded title matches the cache', () => {
    const report = checkAdoptedTitleDrift(
      FILE,
      [add({ title: 'Fix the thing' })],
      index([indexEntry({ title: 'Fix the thing' })]),
    );
    expect(report.findings).toEqual([]);
  });

  it('reports nothing when there is no local index yet', () => {
    const report = checkAdoptedTitleDrift(
      FILE,
      [add({ title: 'Fix the thing' })],
      null,
    );
    expect(report.findings).toEqual([]);
  });

  it('flags a recorded title that diverged from the cached issue title', () => {
    const report = checkAdoptedTitleDrift(
      FILE,
      [add({ id: 'CORE-a', title: 'Fix the thing' })],
      index([indexEntry({ id: 'CORE-a', title: 'Fix the widget instead' })]),
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('backlog-adopt/title-drift');
    expect(report.findings[0]?.level).toBe('warn');
    expect(report.findings[0]?.msg).toContain('Fix the widget instead');
  });
});

describe('checkTargetLabelCollisions', () => {
  it('reports nothing when every target label is unique', () => {
    const report = checkTargetLabelCollisions(FILE, [
      target({ name: 'core', label: 'Core' }),
      target({ name: 'cli', label: 'CLI' }),
    ]);
    expect(report.findings).toEqual([]);
  });

  it('flags two targets sharing a label, case-insensitively', () => {
    const report = checkTargetLabelCollisions(FILE, [
      target({ name: 'core', label: 'Core' }),
      target({ name: 'core-two', label: 'core' }),
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe(
      'backlog-adopt/target-label-collision',
    );
    expect(report.findings[0]?.msg).toContain('core, core-two');
  });
});

describe('checkTargetPathPrefixOverlap', () => {
  it('reports nothing when path prefixes are disjoint', () => {
    const report = checkTargetPathPrefixOverlap(FILE, [
      target({ name: 'core', pathPrefix: 'packages/core/' }),
      target({ name: 'cli', pathPrefix: 'packages/cli/' }),
    ]);
    expect(report.findings).toEqual([]);
  });

  it('does not flag one pathPrefix nested inside another, since it resolves by longest match', () => {
    const report = checkTargetPathPrefixOverlap(FILE, [
      target({ name: 'core', pathPrefix: 'packages/core/' }),
      target({
        name: 'core-fixture',
        pathPrefix: 'packages/core/test/fixture/',
      }),
    ]);
    expect(report.findings).toEqual([]);
  });

  it('flags two targets with the identical pathPrefix', () => {
    const report = checkTargetPathPrefixOverlap(FILE, [
      target({ name: 'core', pathPrefix: 'packages/core/' }),
      target({ name: 'core-two', pathPrefix: 'packages/core/' }),
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe(
      'backlog-adopt/target-path-prefix-overlap',
    );
    expect(report.findings[0]?.msg).toContain('core, core-two');
  });
});
