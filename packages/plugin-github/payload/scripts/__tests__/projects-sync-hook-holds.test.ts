import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';

const SCRIPT = '.claude/scripts/projects-sync.mjs';
const HOOK = '.claude/scripts/projects-sync-hook.mjs';
const HOLDS = '.claude/state/projects-sync-holds.json';
const PUSH_LOG = '.claude/state/projects-sync.log';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER_SESSION = 'bbbbbbbb-1111-2222-3333-444444444444';
const REJECTED_ID = 'HOUSERULES-aaaaaa';
const OTHER_ID = 'HOUSERULES-bbbbbb';

const GH_STUB = '#!/usr/bin/env node\nprocess.exit(1);\n';

function backlogRow(id: string, ts: string, chat: string): string {
  return JSON.stringify({
    ts,
    id,
    action: 'add',
    file: 'BACKLOG.md',
    title: `Row ${id}`,
    chat,
    content: gzipSync(Buffer.from('body', 'utf8')).toString('base64'),
  });
}

function installedRepoWithQueue(rows: readonly string[]): string {
  const root = useInstalledRepo('pnpm-monorepo', {
    modules: 'projects/projects',
    plugins: [{ name: PLUGIN_DIR, alias: 'projects' }],
  });
  runIn(root, 'git', [
    'remote',
    'add',
    'origin',
    'https://github.com/octocat/hello-world.git',
  ]);
  const ledgerDir = join(root, '.claude/ledgers');
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(
    join(ledgerDir, '.projects.json'),
    JSON.stringify({
      backlog: { number: 1, id: 'proj-backlog' },
      decisions: { number: 2, id: 'proj-decisions' },
    }),
  );
  writeFileSync(join(ledgerDir, 'backlog.jsonl'), `${rows.join('\n')}\n`);
  return root;
}

function transcriptWithRejectedTurn(root: string, rejected: boolean): string {
  const path = join(root, 'transcript.jsonl');
  const lines = [
    {
      type: 'user',
      sessionId: SESSION,
      timestamp: '2026-11-24T10:00:00.000Z',
      message: { role: 'user', content: 'log it and fix it' },
    },
    {
      type: 'user',
      sessionId: SESSION,
      timestamp: '2026-11-24T10:00:30.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            content: rejected
              ? "The user doesn't want to proceed with this tool use. The tool use was rejected."
              : 'The file has been updated successfully.',
            tool_use_id: 'toolu_1',
          },
        ],
      },
      ...(rejected ? { toolDenialKind: 'user-rejected' } : {}),
    },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  return path;
}

function sessionEndInput(transcriptPath: string): string {
  return JSON.stringify({
    session_id: SESSION,
    transcript_path: transcriptPath,
    hook_event_name: 'SessionEnd',
    reason: 'exit',
  });
}

function readHeld(root: string): Record<string, string> {
  const path = join(root, HOLDS);
  return existsSync(path)
    ? (
        JSON.parse(readFileSync(path, 'utf8')) as {
          held: Record<string, string>;
        }
      ).held
    : {};
}

describe('projects-sync hook, holding rows from a rejected turn', () => {
  let stubDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
    const ghPath = join(stubDir, 'gh');
    writeFileSync(ghPath, GH_STUB);
    chmodSync(ghPath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${originalPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(stubDir, { recursive: true, force: true });
  });

  it('records the hold and spawns no push when the only queued row was written in a rejected turn', () => {
    const root = installedRepoWithQueue([
      backlogRow(REJECTED_ID, '2026-11-24T10:00:10.000Z', SESSION),
    ]);
    const transcript = transcriptWithRejectedTurn(root, true);

    const result = runScript(root, HOOK, {
      input: sessionEndInput(transcript),
    });

    expect(result.status).toBe(0);
    expect(readHeld(root)).toEqual({
      [REJECTED_ID]: '2026-11-24T10:00:10.000Z',
    });
    expect(
      existsSync(join(root, PUSH_LOG)),
      'a push log means the hook spawned a push for the held row',
    ).toBe(false);
  });

  it('spawns a push for the same row when its turn was clean, so the case above proves the hold', () => {
    const root = installedRepoWithQueue([
      backlogRow(REJECTED_ID, '2026-11-24T10:00:10.000Z', SESSION),
    ]);
    const transcript = transcriptWithRejectedTurn(root, false);

    const result = runScript(root, HOOK, {
      input: sessionEndInput(transcript),
    });

    expect(result.status).toBe(0);
    expect(readHeld(root)).toEqual({});
    expect(existsSync(join(root, PUSH_LOG)), 'no push was spawned').toBe(true);
  });

  it('still spawns a push for an unheld row from another session', () => {
    const root = installedRepoWithQueue([
      backlogRow(REJECTED_ID, '2026-11-24T10:00:10.000Z', SESSION),
      backlogRow(OTHER_ID, '2026-11-24T10:00:12.000Z', OTHER_SESSION),
    ]);
    const transcript = transcriptWithRejectedTurn(root, true);

    const result = runScript(root, HOOK, {
      input: sessionEndInput(transcript),
    });

    expect(result.status).toBe(0);
    expect(Object.keys(readHeld(root))).toEqual([REJECTED_ID]);
    expect(existsSync(join(root, PUSH_LOG)), 'no push was spawned').toBe(true);
  });

  it('merges a new hold into the file without dropping the ids already held', () => {
    const root = installedRepoWithQueue([
      backlogRow(REJECTED_ID, '2026-11-24T10:00:10.000Z', SESSION),
    ]);
    mkdirSync(join(root, '.claude/state'), { recursive: true });
    writeFileSync(
      join(root, HOLDS),
      JSON.stringify({
        held: { [OTHER_ID]: '2026-11-23T09:00:00.000Z' },
        released: {},
      }),
    );
    const transcript = transcriptWithRejectedTurn(root, true);

    runScript(root, HOOK, { input: sessionEndInput(transcript) });

    expect(readHeld(root)).toEqual({
      [OTHER_ID]: '2026-11-23T09:00:00.000Z',
      [REJECTED_ID]: '2026-11-24T10:00:10.000Z',
    });
  });

  it('exits 0 and spawns no push when the transcript path does not exist', () => {
    const root = installedRepoWithQueue([
      backlogRow(REJECTED_ID, '2026-11-24T10:00:10.000Z', SESSION),
    ]);

    const result = runScript(root, HOOK, {
      input: sessionEndInput(join(root, 'missing.jsonl')),
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(root, PUSH_LOG)), 'a push was spawned').toBe(false);
  });
});

describe('projects-sync release', () => {
  it('clears one hold and keeps the others', () => {
    const root = installedRepoWithQueue([]);
    mkdirSync(join(root, '.claude/state'), { recursive: true });
    writeFileSync(
      join(root, HOLDS),
      JSON.stringify({
        held: {
          [REJECTED_ID]: '2026-11-24T10:00:10.000Z',
          [OTHER_ID]: '2026-11-24T10:00:12.000Z',
        },
        released: {},
      }),
    );

    const result = runScript(root, SCRIPT, { args: ['release', REJECTED_ID] });

    expect(result.status, result.stderr).toBe(0);
    expect(readHeld(root)).toEqual({ [OTHER_ID]: '2026-11-24T10:00:12.000Z' });
  });

  it('exits 1 naming the id when it is not held', () => {
    const root = installedRepoWithQueue([]);

    const result = runScript(root, SCRIPT, { args: ['release', REJECTED_ID] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${REJECTED_ID} is not held.`);
  });
});
