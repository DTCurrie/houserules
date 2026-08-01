// The end-to-end suites spawn the built CLI (`dist/cli.js`), not the sources, so the
// build has to exist before any of them run. Doing it here rather than in the `test`
// script keeps `vitest` and `vitest run` self-sufficient — no stale-dist failures
// that look like test bugs.

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export default function setup(): void {
  execFileSync(
    'node',
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
}
