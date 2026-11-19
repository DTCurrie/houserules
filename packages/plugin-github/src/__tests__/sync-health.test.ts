import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Ctx } from '@houserules/api';

import { formatPushOutcome } from '../../payload/scripts/lib/push-outcome.mjs';
import { checkSyncHealth } from '../sync-health.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sync-health-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctxFor(houseConfig: unknown = null): Ctx {
  return { root, claude: { houseConfig } } as unknown as Ctx;
}

function allowSync(): void {
  mkdirSync(join(root, '.claude/ledgers'), { recursive: true });
  writeFileSync(join(root, '.claude/ledgers/.projects.json'), '{}');
}

function writeLog(text: string): void {
  mkdirSync(join(root, '.claude/state'), { recursive: true });
  writeFileSync(join(root, '.claude/state/projects-sync.log'), text);
}

const OK = formatPushOutcome({
  at: '2026-11-18T10:00:00.000Z',
  exitCode: 0,
  error: null,
  pending: { backlog: 0, decisions: 2 },
});
const FAILED = formatPushOutcome({
  at: '2026-11-18T11:00:00.000Z',
  exitCode: 1,
  error: 'gh: HTTP 401',
  pending: { backlog: 3, decisions: 4 },
});

describe('checkSyncHealth', () => {
  it('reads one readout and no finding after a clean push', () => {
    allowSync();
    writeLog(`noise\n${OK}\n`);

    const result = checkSyncHealth(ctxFor());

    expect(result.findings).toHaveLength(0);
    expect(result.readouts).toHaveLength(1);
    expect(result.readouts[0]).toContain('2026-11-18T10:00:00.000Z');
    expect(result.readouts[0]).toContain('2 pending (backlog 0, decisions 2)');
  });

  it('warns once with the error, the split, and the inspect command when the last push failed', () => {
    allowSync();
    writeLog(`before\n${OK}\nmore\n${FAILED}\ntrailing free-form\n`);

    const result = checkSyncHealth(ctxFor());

    expect(result.readouts).toHaveLength(0);
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding?.level).toBe('WARN');
    expect(finding?.msg).toContain('2026-11-18T11:00:00.000Z');
    expect(finding?.msg).toContain('gh: HTTP 401');
    expect(finding?.msg).toContain('7 pending (backlog 3, decisions 4)');
    expect(finding?.msg).toContain(
      'node .claude/scripts/projects-sync.mjs push --dry-run',
    );
  });

  it('says no error was recorded when the failed push carried none', () => {
    allowSync();
    writeLog(
      `${formatPushOutcome({ at: 'T', exitCode: 2, error: null, pending: null })}\n`,
    );

    const [finding] = checkSyncHealth(ctxFor()).findings;

    expect(finding?.msg).toContain('no error was recorded');
    expect(finding?.msg).toContain('pending count unavailable');
  });

  it('prints nothing when there is no enable token', () => {
    writeLog(`${FAILED}\n`);

    const result = checkSyncHealth(ctxFor());

    expect(result.findings).toHaveLength(0);
    expect(result.readouts).toHaveLength(0);
  });

  it('prints nothing when autoSync is false', () => {
    allowSync();
    writeLog(`${FAILED}\n`);

    const result = checkSyncHealth(ctxFor({ projects: { autoSync: false } }));

    expect(result.findings).toHaveLength(0);
    expect(result.readouts).toHaveLength(0);
  });

  it('falls back to the previous valid outcome when the last line is truncated', () => {
    allowSync();
    writeLog(`${FAILED}\n${OK.slice(0, OK.length - 9)}`);

    const result = checkSyncHealth(ctxFor());

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.msg).toContain('gh: HTTP 401');
  });

  it('skips an outcome line of the wrong shape', () => {
    allowSync();
    writeLog(`${OK}\nprojects-sync push outcome {"at":1}\n`);

    const result = checkSyncHealth(ctxFor());

    expect(result.findings).toHaveLength(0);
    expect(result.readouts[0]).toContain('succeeded');
  });

  it('reads one no-push-yet readout when the log is missing', () => {
    allowSync();

    const result = checkSyncHealth(ctxFor());

    expect(result.findings).toHaveLength(0);
    expect(result.readouts).toEqual([
      'projects: no ledger push is recorded yet',
    ]);
  });

  it('finds the token in a configured ledger directory', () => {
    mkdirSync(join(root, 'ledgers-x'), { recursive: true });
    writeFileSync(join(root, 'ledgers-x/.projects.json'), '{}');
    writeLog(`${FAILED}\n`);

    const result = checkSyncHealth(ctxFor({ ledgers: { dir: 'ledgers-x' } }));

    expect(result.findings).toHaveLength(1);
  });
});
