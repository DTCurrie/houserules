import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
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
const LOCK = '.claude/state/projects-sync.lock';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const BACKLOG_ID = 'HOUSERULES-aaaaaa';
// Past the 10 minute ceiling the plan sets on the stale bound.
const OVER_STALE_BOUND_MS = 11 * 60 * 1000;

const GH_STUB = `#!/usr/bin/env node
const { appendFileSync, readFileSync, existsSync } = require('node:fs');
const dir = process.env.GH_STUB_DIR;
const args = process.argv.slice(2);
appendFileSync(dir + '/calls.log', args.join(' ').slice(0, 200).split('\\n')[0] + '\\n');

if (args[0] === '--version') process.exit(0);

if (args[0] === 'auth' && args[1] === 'status') {
  const scopes = process.env.GH_STUB_SCOPES || "'repo', 'project'";
  process.stderr.write("Logged in to github.com as octocat\\n  - Token scopes: " + scopes + "\\n");
  appendFileSync(dir + '/auth.log', 'x\\n');
  process.exit(0);
}

if (args[0] === 'api' && typeof args[1] === 'string' && args[1].startsWith('repos/')) {
  console.log(JSON.stringify({ admin: true, maintain: true, push: true, triage: true, pull: true }));
  process.exit(0);
}

if (args[0] === 'api' && args[1] === 'graphql') {
  const query = args[3].slice('query='.length);
  if (query.includes('createIssue(input:')) {
    const CREATE_WAIT_MS = 1500;
    const POLL_MS = 25;
    const deadline = Date.now() + CREATE_WAIT_MS;
    const seen = () => existsSync(dir + '/auth.log') && readFileSync(dir + '/auth.log', 'utf8').split('\\n').filter(Boolean).length >= 2;
    while (!seen() && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, POLL_MS);
    appendFileSync(dir + '/creates.log', 'create\\n');
    console.log(JSON.stringify({ data: { createIssue: { issue: { id: 'issue-node-1', number: 101 } } } }));
    process.exit(0);
  }
  if (query.includes('addProjectV2ItemById(input:')) {
    appendFileSync(dir + '/items.log', 'item\\n');
    console.log(JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'item-1' } } } }));
    process.exit(0);
  }
  if (query.includes('fields(first: 50)')) {
    const nodes = [
      { id: 'field-status', name: 'Status', options: [{ id: 'opt-todo', name: 'Todo' }, { id: 'opt-accepted', name: 'Accepted' }] },
      { id: 'field-area', name: 'Area' },
      { id: 'field-filed', name: 'Filed' },
    ];
    console.log(JSON.stringify({ data: { node: { fields: { nodes } } } }));
    process.exit(0);
  }
  if (query.includes('updateProjectV2ItemFieldValue(input:')) {
    console.log(JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item-1' } } } }));
    process.exit(0);
  }
  if (query.includes('repository(owner:')) {
    console.log(JSON.stringify({ data: { repository: { id: 'repo-node-1' } } }));
    process.exit(0);
  }
}
process.exit(1);
`;

function stage(): string {
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
  writeFileSync(
    join(ledgerDir, 'backlog.jsonl'),
    `${JSON.stringify({
      ts: '2026-01-01T00:00:00.000Z',
      id: BACKLOG_ID,
      action: 'add',
      file: 'BACKLOG.md',
      title: 'One queued row',
      chat: null,
      content: gzipSync(Buffer.from('body', 'utf8')).toString('base64'),
    })}\n`,
  );
  return root;
}

function writeLock(root: string, pid: number, startedAt: number): void {
  mkdirSync(join(root, '.claude/state'), { recursive: true });
  writeFileSync(join(root, LOCK), JSON.stringify({ pid, startedAt }));
}

/** A pid that belonged to a process that has already exited. */
function deadPid(): number {
  const result = runIn(process.cwd(), process.execPath, [
    '-e',
    'process.stdout.write(String(process.pid))',
  ]);
  return Number(result);
}

function lines(file: string): string[] {
  return existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean)
    : [];
}

function runAsync(
  root: string,
  args: string[],
): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolveRun) => {
    const env = { ...process.env };
    delete env.NODE_PATH;
    const child = spawn(process.execPath, [join(root, SCRIPT), ...args], {
      cwd: root,
      env,
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.on('close', (status) => resolveRun({ status, stdout }));
  });
}

describe('projects-sync push lock', () => {
  let stubDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
    const ghPath = join(stubDir, 'gh');
    writeFileSync(ghPath, GH_STUB);
    chmodSync(ghPath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`;
    process.env.GH_STUB_DIR = stubDir;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.GH_STUB_DIR;
    delete process.env.GH_STUB_SCOPES;
    rmSync(stubDir, { recursive: true, force: true });
  });

  it('skips a push while a live, fresh lock is held, with no gh call and exit 0', () => {
    const root = stage();
    writeLock(root, process.pid, Date.now());

    const result = runScript(root, SCRIPT, { args: ['push'] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Another push holds the lock');
    expect(lines(join(stubDir, 'calls.log'))).toEqual([]);
    expect(existsSync(join(root, LOCK))).toBe(true);
  });

  it('takes over a lock whose pid is gone and releases it afterward', () => {
    const root = stage();
    writeLock(root, deadPid(), Date.now());

    const result = runScript(root, SCRIPT, { args: ['push'] });

    expect(result.status).toBe(0);
    expect(lines(join(stubDir, 'creates.log'))).toHaveLength(1);
    expect(existsSync(join(root, LOCK))).toBe(false);
  });

  it('takes over a lock older than the bound even when its pid is alive', () => {
    const root = stage();
    writeLock(root, process.pid, Date.now() - OVER_STALE_BOUND_MS);

    const result = runScript(root, SCRIPT, { args: ['push'] });

    expect(result.status).toBe(0);
    expect(lines(join(stubDir, 'creates.log'))).toHaveLength(1);
    expect(existsSync(join(root, LOCK))).toBe(false);
  });

  it('releases the lock when the push fails', () => {
    process.env.GH_STUB_SCOPES = "'repo'";
    const root = stage();

    const result = runScript(root, SCRIPT, { args: ['push'] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('missing the `project` scope');
    expect(existsSync(join(root, LOCK))).toBe(false);
  });

  it('lets two concurrent pushes over one queued row create one issue and one board item', async () => {
    const root = stage();

    const [first, second] = await Promise.all([
      runAsync(root, ['push']),
      runAsync(root, ['push']),
    ]);

    expect([first.status, second.status]).toEqual([0, 0]);
    expect(lines(join(stubDir, 'creates.log'))).toHaveLength(1);
    expect(lines(join(stubDir, 'items.log'))).toHaveLength(1);
    expect(existsSync(join(root, LOCK))).toBe(false);
  });
});

describe('projects-sync hook, push lock', () => {
  let stubDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
    const ghPath = join(stubDir, 'gh');
    writeFileSync(ghPath, GH_STUB);
    chmodSync(ghPath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`;
    process.env.GH_STUB_DIR = stubDir;
    process.env.GH_STUB_SCOPES = "'repo'";
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.GH_STUB_DIR;
    delete process.env.GH_STUB_SCOPES;
    rmSync(stubDir, { recursive: true, force: true });
  });

  it('spawns no push while a live, fresh lock is held', () => {
    const root = stage();
    writeLock(root, process.pid, Date.now());

    const result = runScript(root, HOOK, { input: '{}' });

    expect(result.status).toBe(0);
    expect(existsSync(join(root, '.claude/state/projects-sync.log'))).toBe(
      false,
    );
  });

  it('spawns a push when the lock is stale, so the held case above proves the lock', () => {
    const root = stage();
    writeLock(root, deadPid(), Date.now());

    const result = runScript(root, HOOK, { input: '{}' });

    expect(result.status).toBe(0);
    expect(existsSync(join(root, '.claude/state/projects-sync.log'))).toBe(
      true,
    );
  });
});
