import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
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
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));

const GH_STUB = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');

const CALLS_PATH = 'gh-graphql-calls.log';
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
  appendFileSync(CALLS_PATH, \`\${query}\\n\`);

  if (query.includes('fields(first: 50)')) {
    const nodes = [
      { id: 'field-status', name: 'Status', options: [{ id: 'opt-todo', name: 'Todo' }, { id: 'opt-accepted', name: 'Accepted' }] },
      { id: 'field-area', name: 'Area' },
      { id: 'field-filed', name: 'Filed' },
    ];
    console.log(JSON.stringify({ data: { node: { fields: { nodes } } } }));
    process.exit(0);
  }

  if (query.includes('content { ... on DraftIssue { id } }')) {
    console.log(JSON.stringify({ data: { node: { content: { id: 'draft-content-1' } } } }));
    process.exit(0);
  }

  if (query.includes('updateProjectV2DraftIssue(input:')) {
    console.log(JSON.stringify({ data: { updateProjectV2DraftIssue: { draftIssue: { id: 'draft-content-1' } } } }));
    process.exit(0);
  }

  if (query.includes('updateProjectV2ItemFieldValue(input:')) {
    console.log(JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item-1' } } } }));
    process.exit(0);
  }

  if (query.includes('addProjectV2ItemById(input:')) {
    console.log(JSON.stringify({ data: { addProjectV2ItemById: { item: { id: 'item-1' } } } }));
    process.exit(0);
  }

  if (query.includes('updateIssue(input:')) {
    console.log(JSON.stringify({ data: { updateIssue: { issue: { id: 'issue-node-1' } } } }));
    process.exit(0);
  }

  if (query.includes('issue(number:')) {
    console.log(JSON.stringify({ data: { repository: { issue: { id: 'issue-node-1' } } } }));
    process.exit(0);
  }

  if (query.includes('repository(owner:')) {
    console.log(JSON.stringify({ data: { repository: { id: 'repo-node-1' } } }));
    process.exit(0);
  }

  process.exit(1);
}

process.exit(1);
`;

const BACKLOG_ID = 'HOUSERULES-aaaaaa';
const DECISION_ID = 'HOUSERULES-bbbbbb';

function encodeBody(body: string): string {
  return gzipSync(Buffer.from(body, 'utf8')).toString('base64');
}

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
    [
      JSON.stringify({
        ts: '2026-01-01T00:00:00.000Z',
        id: BACKLOG_ID,
        action: 'add',
        file: 'BACKLOG.md',
        title: 'Old title',
        chat: null,
        content: encodeBody('old body'),
      }),
      JSON.stringify({
        ts: '2026-01-01T00:01:00.000Z',
        id: BACKLOG_ID,
        action: 'synced',
        op: 'create-issue',
        issue: 101,
      }),
      JSON.stringify({
        ts: '2026-01-01T00:02:00.000Z',
        id: BACKLOG_ID,
        action: 'update',
        title: 'New title',
        content: encodeBody('new body'),
      }),
    ].join('\n') + '\n',
  );

  writeFileSync(
    join(ledgerDir, 'backlog.index.json'),
    JSON.stringify({
      version: 1,
      kind: 'backlog',
      pulledAt: '2026-01-01T00:00:00.000Z',
      projects: [1],
      entries: [
        {
          id: BACKLOG_ID,
          itemId: '',
          issue: 101,
          title: 'Old title',
          body: 'old body',
          surface: 'BACKLOG.md',
          date: '2026-01-01',
          chat: null,
          status: 'Todo',
          scope: [],
          under: null,
          supersedes: [],
          supersededBy: null,
        },
      ],
    }),
  );

  writeFileSync(
    join(ledgerDir, 'decisions.jsonl'),
    [
      JSON.stringify({
        ts: '2026-01-01T00:00:00.000Z',
        id: DECISION_ID,
        action: 'decide',
        file: 'DECISIONS.md',
        title: 'Old decision',
        chat: null,
        content: encodeBody('old decision body'),
      }),
      JSON.stringify({
        ts: '2026-01-01T00:01:00.000Z',
        id: DECISION_ID,
        action: 'synced',
        op: 'create-draft',
        itemId: 'draft-1',
      }),
      JSON.stringify({
        ts: '2026-01-01T00:02:00.000Z',
        id: DECISION_ID,
        action: 'amend',
        content: encodeBody('new decision body'),
      }),
    ].join('\n') + '\n',
  );

  writeFileSync(
    join(ledgerDir, 'decisions.index.json'),
    JSON.stringify({
      version: 1,
      kind: 'decisions',
      pulledAt: '2026-01-01T00:00:00.000Z',
      projects: [2],
      entries: [
        {
          id: DECISION_ID,
          itemId: 'draft-1',
          issue: null,
          title: 'Old decision',
          body: 'old decision body',
          surface: 'DECISIONS.md',
          date: '2026-01-01',
          chat: null,
          status: 'Accepted',
          scope: [],
          under: null,
          supersedes: [],
          supersededBy: null,
        },
      ],
    }),
  );

  return root;
}

function run(root: string) {
  return runScript(root, SCRIPT, { args: ['push'] });
}

function readCalls(root: string): string {
  return readFileSync(join(root, 'gh-graphql-calls.log'), 'utf8');
}

describe('projects-sync push, entry marker on an update', () => {
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
    rmSync(stubDir, { recursive: true, force: true });
  });

  it('carries the entry marker in an update-issue body sent to GitHub', () => {
    const root = stage();

    const result = run(root);

    expect(result.status).toBe(0);
    const calls = readCalls(root);
    const updateIssueCall = calls
      .split('\n')
      .find((line) => line.includes('updateIssue(input:'));
    expect(updateIssueCall).toContain(
      `<!-- houserules:entry:${BACKLOG_ID} -->`,
    );
  });

  it('carries the entry marker in an update-draft body sent to GitHub', () => {
    const root = stage();

    const result = run(root);

    expect(result.status).toBe(0);
    const calls = readCalls(root);
    const updateDraftCall = calls
      .split('\n')
      .find((line) => line.includes('updateProjectV2DraftIssue(input:'));
    expect(updateDraftCall).toContain(
      `<!-- houserules:entry:${DECISION_ID} -->`,
    );
  });
});
