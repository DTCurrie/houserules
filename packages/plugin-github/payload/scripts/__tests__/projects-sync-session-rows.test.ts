import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
const PUSH_LOG = '.claude/state/projects-sync.log';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const SESSION = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER_SESSION = 'bbbbbbbb-1111-2222-3333-444444444444';
const OWN_ID = 'HOUSERULES-aaaaaa';
const OTHER_ID = 'HOUSERULES-bbbbbb';
const HOUR_MS = 60 * 60 * 1000;

const GH_STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);

if (args[0] === '--version') process.exit(0);

if (args[0] === 'auth' && args[1] === 'status') {
  process.stderr.write("Logged in to github.com as octocat\\n  - Token scopes: 'repo', 'project'\\n");
  process.exit(0);
}

if (args[0] === 'api' && typeof args[1] === 'string' && args[1].startsWith('repos/')) {
  console.log(JSON.stringify({ admin: true, maintain: true, push: true, triage: true, pull: true }));
  process.exit(0);
}

process.exit(1);
`;

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

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

function sessionEndInput(): string {
  return JSON.stringify({
    session_id: SESSION,
    hook_event_name: 'SessionEnd',
    reason: 'exit',
  });
}

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

describe('projects-sync push, with and without --session', () => {
  it('plans only the ending session its own entry while another live session wrote a row an hour ago', () => {
    const root = installedRepoWithQueue([
      backlogRow(OWN_ID, hoursAgo(2), SESSION),
      backlogRow(OTHER_ID, hoursAgo(1), OTHER_SESSION),
    ]);

    const result = runScript(root, SCRIPT, {
      args: ['push', '--dry-run', '--session', SESSION],
    });

    expect(result.status, result.stderr).toBe(0);
    expect(
      result.stdout.split('\n').filter((line) => line.startsWith('create-')),
    ).toEqual([`create-issue ${OWN_ID} (backlog) -> BACKLOG.md`]);
  });

  it('plans every queued entry when no session is named', () => {
    const root = installedRepoWithQueue([
      backlogRow(OWN_ID, hoursAgo(2), SESSION),
      backlogRow(OTHER_ID, hoursAgo(1), OTHER_SESSION),
    ]);

    const result = runScript(root, SCRIPT, { args: ['push', '--dry-run'] });

    expect(result.status, result.stderr).toBe(0);
    expect(
      result.stdout.split('\n').filter((line) => line.startsWith('create-')),
    ).toEqual([
      `create-issue ${OWN_ID} (backlog) -> BACKLOG.md`,
      `create-issue ${OTHER_ID} (backlog) -> BACKLOG.md`,
    ]);
  });
});

describe('projects-sync hook, rows another session wrote', () => {
  it('spawns no push when the only queued row is one another session wrote an hour ago', () => {
    const root = installedRepoWithQueue([
      backlogRow(OTHER_ID, hoursAgo(1), OTHER_SESSION),
    ]);

    const result = runScript(root, HOOK, { input: sessionEndInput() });

    expect(result.status).toBe(0);
    expect(
      existsSync(join(root, PUSH_LOG)),
      'a push log means the hook spawned a push for a row of a live session',
    ).toBe(false);
  });

  it('spawns a push when that row is 25 hours old, so the case above proves the age rule', () => {
    const root = installedRepoWithQueue([
      backlogRow(OTHER_ID, hoursAgo(25), OTHER_SESSION),
    ]);

    const result = runScript(root, HOOK, { input: sessionEndInput() });

    expect(result.status).toBe(0);
    expect(existsSync(join(root, PUSH_LOG)), 'no push was spawned').toBe(true);
  });
});
