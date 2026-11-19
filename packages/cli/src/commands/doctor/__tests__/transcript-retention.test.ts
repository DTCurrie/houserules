import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { claudeProjectDir } from '@houserules/payload/entry-ledger';

import { makeCtx } from '#test/ctx-builder';
import { checkTranscriptRetention } from '../transcript-retention.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-18T12:00:00Z');

function fixture(): { top: string; configDir: string; transcripts: string } {
  const base = mkdtempSync(join(tmpdir(), 'doctor-retention-'));
  const top = join(base, 'repo');
  const configDir = join(base, 'config');
  mkdirSync(top, { recursive: true });
  const projects = join(configDir, 'projects');
  const transcripts = join(projects, claudeProjectDir(top, projects));
  mkdirSync(transcripts, { recursive: true });
  return { top, configDir, transcripts };
}

function run(top: string, configDir: string) {
  const ctx = makeCtx({
    root: top,
    git: { isRepo: true, top, hasCommits: true, branch: 'main' },
  });
  return checkTranscriptRetention(ctx, { configDir, now: NOW });
}

describe('checkTranscriptRetention', () => {
  it('reads out the default and the oldest transcript when the setting is unset', () => {
    const { top, configDir, transcripts } = fixture();
    const file = join(transcripts, 's.jsonl');
    writeFileSync(file, '');
    const old = new Date(NOW - 20 * DAY);
    utimesSync(file, old, old);

    const result = run(top, configDir);

    expect(result.findings).toEqual([]);
    expect(result.readouts).toEqual([
      'Claude Code deletes transcripts after cleanupPeriodDays, default 30',
      'oldest transcript 2026-10-29 (20 days old)',
    ]);
  });

  it('reads out the value and its file when the setting is a number', () => {
    const { top, configDir, transcripts } = fixture();
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ cleanupPeriodDays: 90 }),
    );
    writeFileSync(join(transcripts, 's.jsonl'), '');

    const [setLine] = run(top, configDir).readouts;

    expect(setLine).toBe(
      `Claude Code deletes transcripts after cleanupPeriodDays, set to 90 in ${join(configDir, 'settings.json')}`,
    );
  });

  it('says so when no transcripts are on disk', () => {
    const { top, configDir, transcripts } = fixture();

    const [, oldestLine] = run(top, configDir).readouts;

    expect(oldestLine).toBe(`no transcripts on disk at ${transcripts}`);
  });
});
