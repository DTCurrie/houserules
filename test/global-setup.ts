import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Builds the CLI before any suite runs. The end-to-end suites spawn `dist/cli.js` rather
 * than the sources, so the build has to exist first. Doing it here rather than in the
 * `test` script keeps `vitest` and `vitest run` self-sufficient, and avoids stale-dist
 * failures that look like test bugs.
 */
export default function setup(): void {
  execFileSync(
    'node',
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
}
