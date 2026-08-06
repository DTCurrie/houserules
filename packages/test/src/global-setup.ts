import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Per-run temp state for the suites in this workspace and in any plugin that consumes this
 * package.
 *
 * Building the CLI is NOT this function's job. Every `test` script declares a wireit
 * dependency on `../cli:build:ts`, so `dist/` is present and current before vitest starts,
 * and a consumer installing `@agent-kit/cli` from npm gets `dist/` prebuilt in the tarball.
 * This used to shell out to `tsc` here, which cost a full CLI compile once per package per
 * run, ten of them across the workspace. It could also never have worked outside this
 * workspace, since the published package ships neither `src/` nor `tsconfig.build.json`.
 */
export default function setup(): () => void {
  // Where useInstalledRepo() keeps its per-(shape, modules) snapshots. Created here so
  // teardown can remove it: worker processes cannot clean up after each other, and the
  // snapshots must not outlive the run or they would go stale against a rebuilt CLI.
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'kit-snapshots-'));
  process.env.KIT_TEST_SNAPSHOT_ROOT = snapshotRoot;

  return () => rmSync(snapshotRoot, { recursive: true, force: true });
}
