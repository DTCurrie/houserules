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
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';

const SCRIPT = '.claude/scripts/projects-sync.mjs';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));

const GH_STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  process.stderr.write("Logged in to github.com as octocat\\n  - Token scopes: 'repo', 'project'\\n");
  process.exit(0);
}

if (args[0] === 'api' && typeof args[1] === 'string' && args[1].startsWith('repos/')) {
  console.log(JSON.stringify({ admin: true, maintain: true, push: true, triage: true, pull: true }));
  process.exit(0);
}

if (args[0] === 'api' && args[1] === 'graphql') {
  if (process.env.GH_STUB_GRAPHQL_FAIL === '1') {
    process.stderr.write('gh: something went wrong (HTTP 500)\\n');
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      data: { repositoryOwner: { id: 'owner-id', projectsV2: { nodes: [] } } },
    }),
  );
  process.exit(0);
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
  return root;
}

function run(root: string) {
  return runScript(root, SCRIPT, { args: ['pull'] });
}

describe('projects-sync pull, board resolution', () => {
  let stubDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
    const ghPath = join(stubDir, 'gh');
    writeFileSync(ghPath, GH_STUB);
    chmodSync(ghPath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.GH_STUB_GRAPHQL_FAIL;
    rmSync(stubDir, { recursive: true, force: true });
  });

  it('reports no boards configured when the owner genuinely has none titled for this repo', () => {
    const root = stage();

    const result = run(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      'No project boards were found for this repo',
    );
  });

  it('reports the gh failure instead of the no-board message when listing projects fails', () => {
    process.env.GH_STUB_GRAPHQL_FAIL = '1';
    const root = stage();

    const result = run(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Could not resolve project boards');
    expect(result.stdout).not.toContain('No project boards were found');
  });
});

const BOARD_STUB = `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
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
if (args[0] === 'api' && args[1] === 'graphql') {
  const query = args[3].slice('query='.length);
  if (query.includes('repositoryOwner(')) {
    const nodes = [
      { id: 'proj-backlog', number: 1, title: 'hello-world Backlog', fields: { nodes: [] } },
      { id: 'proj-decisions', number: 2, title: 'hello-world Decisions', fields: { nodes: [] } },
    ];
    console.log(JSON.stringify({ data: { repositoryOwner: { id: 'owner-id', projectsV2: { nodes } } } }));
    process.exit(0);
  }
  if (query.includes('items(first:')) {
    const nodes = query.includes('proj-backlog') ? JSON.parse(readFileSync(process.env.GH_STUB_BOARD, 'utf8')) : [];
    console.log(JSON.stringify({ data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } }));
    process.exit(0);
  }
}
process.exit(1);
`;

function boardItem(
  id: string,
  content: Record<string, unknown> | null,
): Record<string, unknown> {
  return { id: `item-${id}`, content, fieldValues: { nodes: [] } };
}

function issueContent(number: number, state: string, id: string) {
  return {
    __typename: 'Issue',
    number,
    title: `Title ${id}`,
    body: `Body ${id}\n\n<!-- houserules:entry:${id} -->`,
    state,
  };
}

describe('projects-sync pull and status, closed upstream', () => {
  let stubDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
    const ghPath = join(stubDir, 'gh');
    writeFileSync(ghPath, BOARD_STUB);
    chmodSync(ghPath, 0o755);
    writeFileSync(
      join(stubDir, 'board.json'),
      JSON.stringify([
        boardItem('a', issueContent(1, 'OPEN', 'HOUSERULES-aaaaaa')),
        boardItem('b', issueContent(2, 'CLOSED', 'HOUSERULES-bbbbbb')),
        boardItem('c', issueContent(3, 'CLOSED', 'HOUSERULES-cccccc')),
        boardItem('d', {
          __typename: 'DraftIssue',
          title: 'Title d',
          body: 'Body d\n\n<!-- houserules:entry:HOUSERULES-dddddd -->',
        }),
      ]),
    );
    process.env.GH_STUB_BOARD = join(stubDir, 'board.json');
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.GH_STUB_BOARD;
    rmSync(stubDir, { recursive: true, force: true });
  });

  function readBacklogIndex(root: string) {
    const raw = readFileSync(
      join(root, '.claude/ledgers/backlog.index.json'),
      'utf8',
    );
    return JSON.parse(raw) as {
      entries: { id: string; issueState: string | null }[];
    };
  }

  it('indexes every row with its issue state and status lists exactly the closed ones', () => {
    const root = stage();
    mkdirSync(join(root, '.claude/ledgers'), { recursive: true });
    writeFileSync(
      join(root, '.claude/ledgers/.projects.json'),
      JSON.stringify({
        backlog: { number: 1, id: 'proj-backlog' },
        decisions: { number: 2, id: 'proj-decisions' },
      }),
    );

    const pull = run(root);

    expect(pull.status).toBe(0);
    expect(pull.stdout).toContain('2 open rows have an issue closed upstream');
    expect(readBacklogIndex(root).entries).toEqual([
      expect.objectContaining({ id: 'HOUSERULES-aaaaaa', issueState: 'OPEN' }),
      expect.objectContaining({
        id: 'HOUSERULES-bbbbbb',
        issueState: 'CLOSED',
      }),
      expect.objectContaining({
        id: 'HOUSERULES-cccccc',
        issueState: 'CLOSED',
      }),
      expect.objectContaining({ id: 'HOUSERULES-dddddd', issueState: null }),
    ]);

    const status = runScript(root, SCRIPT, { args: ['status'] });

    expect(status.status).toBe(0);
    expect(status.stdout).toContain('closed upstream HOUSERULES-bbbbbb  #2');
    expect(status.stdout).toContain('closed upstream HOUSERULES-cccccc  #3');
    expect(status.stdout).not.toContain('HOUSERULES-aaaaaa');
    expect(status.stdout).not.toContain('HOUSERULES-dddddd');
    expect(status.stdout).toContain('backlog-log.mjs remove');
  });

  it('still writes its index for a contributor with no enable token', () => {
    const root = stage();

    const pull = run(root);

    expect(pull.status).toBe(0);
    expect(existsSync(join(root, '.claude/ledgers/backlog.index.json'))).toBe(
      true,
    );
    expect(readBacklogIndex(root).entries).toHaveLength(4);
  });
});

describe('projects-sync pull, concurrent index writes', () => {
  let stubDir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), 'gh-stub-'));
    const ghPath = join(stubDir, 'gh');
    writeFileSync(ghPath, BOARD_STUB);
    chmodSync(ghPath, 0o755);
    writeFileSync(
      join(stubDir, 'board.json'),
      JSON.stringify([
        boardItem('a', issueContent(1, 'OPEN', 'HOUSERULES-aaaaaa')),
        boardItem('b', issueContent(2, 'CLOSED', 'HOUSERULES-bbbbbb')),
      ]),
    );
    process.env.GH_STUB_BOARD = join(stubDir, 'board.json');
    originalPath = process.env.PATH;
    process.env.PATH = `${stubDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.GH_STUB_BOARD;
    rmSync(stubDir, { recursive: true, force: true });
  });

  it('leaves one complete index and no ENOENT when four pulls write at once', async () => {
    const root = stage();
    const env = { ...process.env };
    delete env.NODE_PATH;
    const pull = () =>
      new Promise<{ status: number | null; stderr: string }>((done) => {
        const child = spawn(process.execPath, [join(root, SCRIPT), 'pull'], {
          cwd: root,
          env,
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
        child.on('close', (status) => done({ status, stderr }));
      });

    const results = await Promise.all([pull(), pull(), pull(), pull()]);

    for (const result of results) {
      expect(result.stderr).not.toContain('ENOENT');
      expect(result.status).toBe(0);
    }
    const index = JSON.parse(
      readFileSync(join(root, '.claude/ledgers/backlog.index.json'), 'utf8'),
    ) as { entries: { id: string }[] };
    expect(index.entries.map((entry) => entry.id)).toEqual([
      'HOUSERULES-aaaaaa',
      'HOUSERULES-bbbbbb',
    ]);
  });
});
