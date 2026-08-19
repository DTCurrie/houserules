import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { useInstalledRepo } from '#test/repo';

const PLUGIN_DIR = fileURLToPath(new URL('../../..', import.meta.url));

function stageOutsideAnyGitRepo(): string {
  const installedRoot = useInstalledRepo('pnpm-monorepo', {
    modules: 'backlog/backlog',
    plugins: [{ name: PLUGIN_DIR, alias: 'backlog' }],
  });
  const detachedScripts = mkdtempSync(join(tmpdir(), 'backlog-log-no-git-'));
  cpSync(join(installedRoot, '.claude', 'scripts'), detachedScripts, {
    recursive: true,
  });
  return detachedScripts;
}

let detachedScripts: string | undefined;
afterEach(() => {
  if (detachedScripts)
    rmSync(detachedScripts, { recursive: true, force: true });
  detachedScripts = undefined;
});

function run() {
  detachedScripts = stageOutsideAnyGitRepo();
  return spawnSync(
    process.execPath,
    [join(detachedScripts, 'backlog-log.mjs'), 'list'],
    { cwd: detachedScripts, encoding: 'utf8' },
  );
}

describe('backlog-log.mjs run outside a git work tree', () => {
  it('exits 0 instead of throwing at module load', () => {
    const r = run();
    expect(r.status).toBe(0);
  });

  it('reports the reason on stderr instead of a stack trace', () => {
    const r = run();
    expect(r.stderr).toMatch(/git (work tree|repository)/i);
    expect(r.stderr).not.toMatch(/at Object\.|at Module\./);
  });
});
