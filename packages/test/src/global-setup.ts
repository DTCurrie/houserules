import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// The CLI's package root, found by resolving its package.json rather than a relative path
// into a sibling package. Any suite that pulls in @agent-kit/test, in this workspace or
// installed from npm by a plugin author, builds the same CLI the same way.
const require = createRequire(import.meta.url);
const CLI_ROOT = dirname(require.resolve('@agent-kit/cli/package.json'));

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
    { cwd: CLI_ROOT, stdio: 'inherit' },
  );

  // Where useInstalledRepo() keeps its per-(shape, modules) snapshots. Created here so
  // teardown can remove it: worker processes cannot clean up after each other, and the
  // snapshots must not outlive the run or they would go stale against a rebuilt CLI.
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'kit-snapshots-'));
  process.env.KIT_TEST_SNAPSHOT_ROOT = snapshotRoot;

  return () => rmSync(snapshotRoot, { recursive: true, force: true });
}
