import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  oldestTranscript,
  resolveRetention,
  windowWarnings,
} from '../transcript-retention.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-18T12:00:00Z');

function layout(files: { user?: string; project?: string; local?: string }): {
  project: string;
  config: string;
} {
  const base = mkdtempSync(join(tmpdir(), 'retention-'));
  const project = join(base, 'repo');
  const config = join(base, 'config');
  mkdirSync(join(project, '.claude'), { recursive: true });
  mkdirSync(config, { recursive: true });
  if (files.user !== undefined)
    writeFileSync(join(config, 'settings.json'), files.user);
  if (files.project !== undefined)
    writeFileSync(join(project, '.claude', 'settings.json'), files.project);
  if (files.local !== undefined)
    writeFileSync(join(project, '.claude', 'settings.local.json'), files.local);
  return { project, config };
}

const setting = (days: unknown) => JSON.stringify({ cleanupPeriodDays: days });

describe('resolveRetention', () => {
  it('is unset at 30 when no file sets it', () => {
    const { project, config } = layout({});

    expect(resolveRetention(project, config)).toEqual({
      days: 30,
      source: null,
    });
  });

  it('prefers the project file over the user file', () => {
    const { project, config } = layout({
      user: setting(10),
      project: setting(90),
    });

    expect(resolveRetention(project, config)).toEqual({
      days: 90,
      source: join(project, '.claude', 'settings.json'),
    });
  });

  it('prefers the local file over the project file', () => {
    const { project, config } = layout({
      project: setting(90),
      local: setting(45),
    });

    expect(resolveRetention(project, config).days).toBe(45);
  });

  it('reads the user file from the config dir', () => {
    const { project, config } = layout({ user: setting(365) });

    expect(resolveRetention(project, config)).toEqual({
      days: 365,
      source: join(config, 'settings.json'),
    });
  });

  it('skips malformed JSON and non-number values without throwing', () => {
    const { project, config } = layout({
      local: '{ not json',
      project: setting('90'),
      user: setting(60),
    });

    expect(resolveRetention(project, config).days).toBe(60);
  });

  it('skips 0 and negative values, which Claude Code rejects', () => {
    const { project, config } = layout({
      local: setting(0),
      project: setting(-5),
    });

    expect(resolveRetention(project, config).source).toBeNull();
  });
});

describe('windowWarnings', () => {
  const retention90 = { days: 90, source: '/home/u/.claude/settings.json' };
  const unset = { days: 30, source: null };

  it('draws no edge warning at 90 days with a 29-day-old first transcript', () => {
    expect(
      windowWarnings(NOW - 29 * DAY, undefined, undefined, NOW, retention90),
    ).toEqual([]);
  });

  it('warns at 90 days with an 89-day-old first transcript, naming value and file', () => {
    const [warning] = windowWarnings(
      NOW - 89 * DAY,
      undefined,
      undefined,
      NOW,
      retention90,
    );

    expect(warning).toContain(
      'cleanupPeriodDays, set to 90 in /home/u/.claude/settings.json',
    );
  });

  it('warns when unset and the first transcript is 29 days old', () => {
    const [warning] = windowWarnings(
      NOW - 29 * DAY,
      undefined,
      undefined,
      NOW,
      unset,
    );

    expect(warning).toContain('cleanupPeriodDays, default 30');
  });

  it('does not warn when unset and the first transcript is 27 days old', () => {
    expect(
      windowWarnings(NOW - 27 * DAY, undefined, undefined, NOW, unset),
    ).toEqual([]);
  });

  it('warns when --since predates the oldest transcript', () => {
    const since = NOW - 50 * DAY;

    const [warning] = windowWarnings(
      NOW - 10 * DAY,
      since,
      '2026-09-29',
      NOW,
      unset,
    );

    expect(warning).toContain(
      '--since 2026-09-29 predates the oldest transcript',
    );
  });
});

describe('oldestTranscript', () => {
  it('picks the oldest .jsonl by mtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transcripts-'));
    const old = new Date('2026-10-01T00:00:00Z');
    const recent = new Date('2026-11-10T00:00:00Z');
    writeFileSync(join(dir, 'a.jsonl'), '');
    writeFileSync(join(dir, 'b.jsonl'), '');
    writeFileSync(join(dir, 'c.txt'), '');
    utimesSync(join(dir, 'a.jsonl'), recent, recent);
    utimesSync(join(dir, 'b.jsonl'), old, old);
    utimesSync(
      join(dir, 'c.txt'),
      new Date('2020-01-01'),
      new Date('2020-01-01'),
    );

    expect(oldestTranscript(dir)?.day).toBe('2026-10-01');
  });

  it('is null for an empty or missing directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'transcripts-'));

    expect(oldestTranscript(dir)).toBeNull();
    expect(oldestTranscript(join(dir, 'absent'))).toBeNull();
  });
});
