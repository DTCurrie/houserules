import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo } from '#test/repo';
import { runIn, runScript } from '#test/run';

const SCRIPT = '.claude/scripts/projects-sync.mjs';
const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));
const PREFIX = 'projects-sync push outcome ';

// A token with `repo` but not `project`, so preflight fails before any network call.
const GH_STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] === 'auth' && args[1] === 'status') {
  process.stderr.write("Logged in to github.com as octocat\\n  - Token scopes: 'repo'\\n");
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

describe('projects-sync push outcome line', () => {
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

  it('ends a failed push with one outcome line carrying the first error and pending counts', () => {
    const root = stage();

    const result = runScript(root, SCRIPT, { args: ['push'] });

    expect(result.status).toBe(1);
    const lines = result.stdout.trimEnd().split('\n');
    const last = lines[lines.length - 1] ?? '';
    expect(last.startsWith(PREFIX)).toBe(true);
    const outcome = JSON.parse(last.slice(PREFIX.length)) as {
      exitCode: number;
      error: string | null;
      pending: { backlog: number; decisions: number } | null;
    };
    expect(outcome.exitCode).toBe(1);
    expect(outcome.error).toBe(result.stderr.split('\n')[0]);
    expect(outcome.error).toContain('missing the `project` scope');
    expect(typeof outcome.pending?.backlog).toBe('number');
    expect(typeof outcome.pending?.decisions).toBe('number');
  });

  it('writes no outcome line for a dry run', () => {
    const root = stage();

    const result = runScript(root, SCRIPT, { args: ['push', '--dry-run'] });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(PREFIX);
  });
});
