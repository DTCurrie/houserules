import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Builds the CLI before any suite runs. The end-to-end suites spawn `dist/cli.js` rather
 * than the sources, so the build has to exist first. Doing it here rather than in the
 * `test` script keeps `vitest` and `vitest run` self-sufficient, and avoids stale-dist
 * failures that look like test bugs.
 */
export default function setup(): () => void {
  execFileSync(
    'node',
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );

  // Where useInstalledRepo() keeps its per-(shape, modules) snapshots. Created here so
  // teardown can remove it: worker processes cannot clean up after each other, and the
  // snapshots must not outlive the run or they would go stale against a rebuilt CLI.
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'kit-snapshots-'));
  process.env.KIT_TEST_SNAPSHOT_ROOT = snapshotRoot;

  return () => rmSync(snapshotRoot, { recursive: true, force: true });
}
