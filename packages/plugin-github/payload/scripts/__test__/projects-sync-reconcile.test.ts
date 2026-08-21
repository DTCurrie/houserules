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

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';

const SCRIPT = '.claude/scripts/projects-sync.mjs';
const GITHUB_PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const BACKLOG_PLUGIN_DIR = fileURLToPath(
  new URL('../../../../plugin-backlog', import.meta.url),
);

const ORPHAN_ID = 'HOUSERULES-orphan01';
const ORPHAN_SURFACE = [
  '# Backlog',
  '',
  `## [${ORPHAN_ID}] An orphaned entry`,
  '',
  '**Filed:** 2026-01-01',
  '',
  'This entry exists only in the rendered surface.',
  '',
].join('\n');

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

if (args[0] === 'api' && args[1] === 'graphql') {
  console.log(JSON.stringify({ data: { repositoryOwner: { id: 'owner-id', projectsV2: { nodes: [] } } } }));
  process.exit(0);
}

process.exit(1);
`;

function stage(): string {
  const root = useInstalledRepo('pnpm-monorepo', {
    modules: 'projects/projects,backlog/backlog',
    plugins: [
      { name: GITHUB_PLUGIN_DIR, alias: 'projects' },
      { name: BACKLOG_PLUGIN_DIR, alias: 'backlog' },
    ],
  });
  runIn(root, 'git', [
    'remote',
    'add',
    'origin',
    'https://github.com/octocat/hello-world.git',
  ]);

  const ledgerDir = join(root, '.claude/ledgers');
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(join(ledgerDir, 'BACKLOG.md'), ORPHAN_SURFACE);

  return root;
}

function backlogMdPath(root: string): string {
  return join(root, '.claude/ledgers/BACKLOG.md');
}

function backlogJsonlPath(root: string): string {
  return join(root, '.claude/ledgers/backlog.jsonl');
}

function readBacklogJsonl(root: string): unknown[] {
  const path = backlogJsonlPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('projects-sync status, surface orphan detection', () => {
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

  it('names a surface-orphaned entry and points at reconcile', () => {
    const root = stage();

    const result = runScript(root, SCRIPT, { args: ['status'] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`surface-orphaned ${ORPHAN_ID}`);
    expect(result.stdout).toContain('reconcile');
  });
});

describe('projects-sync reconcile', () => {
  it('lists surface-orphaned entries and exits non-zero with no flag', () => {
    const root = stage();

    const result = runScript(root, SCRIPT, { args: ['reconcile'] });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`surface-orphaned ${ORPHAN_ID}`);
  });

  it('exits 0 and reports none once no surface-orphaned entries remain', () => {
    const root = stage();
    rmSync(backlogMdPath(root));

    const result = runScript(root, SCRIPT, { args: ['reconcile'] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No surface-orphaned entries.');
  });

  it('--enqueue appends the orphan to the push queue, and status stops naming it', () => {
    const root = stage();

    const enqueueResult = runScript(root, SCRIPT, {
      args: ['reconcile', '--enqueue'],
    });

    expect(enqueueResult.status).toBe(0);
    const records = readBacklogJsonl(root) as Array<{
      id: string;
      action: string;
    }>;
    expect(records.some((r) => r.id === ORPHAN_ID && r.action === 'add')).toBe(
      true,
    );

    const statusResult = runScript(root, SCRIPT, { args: ['reconcile'] });
    expect(statusResult.status).toBe(0);
    expect(statusResult.stdout).toContain('No surface-orphaned entries.');
  });

  it('--drop removes the orphan from the rendered surface', () => {
    const root = stage();
    const ledgerDir = join(root, '.claude/ledgers');
    writeFileSync(join(ledgerDir, '.projects.json'), '{}');
    writeFileSync(
      join(ledgerDir, 'backlog.index.json'),
      JSON.stringify({
        version: 1,
        kind: 'backlog',
        pulledAt: '2026-01-01T00:00:00.000Z',
        projects: [],
        entries: [],
      }),
    );

    const result = runScript(root, SCRIPT, { args: ['reconcile', '--drop'] });

    expect(result.status).toBe(0);
    const content = existsSync(backlogMdPath(root))
      ? readFileSync(backlogMdPath(root), 'utf8')
      : '';
    expect(content).not.toContain(ORPHAN_ID);
  });
});
