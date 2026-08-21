import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
