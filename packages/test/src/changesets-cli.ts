import { appendFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Links an installed `@changesets/cli` into a fixture repo's `node_modules`, so a script that
 * resolves it from the repo root finds the real package, and git-ignores `node_modules/` there.
 *
 * The caller resolves the directory, because this package does not depend on `@changesets/cli`
 * and so cannot resolve it from its own location.
 *
 * @param root The fixture repo root.
 * @param installedCliDir The directory of the installed `@changesets/cli` package, such as
 * `dirname(createRequire(import.meta.url).resolve('@changesets/cli/package.json'))`.
 */
export function linkInstalledChangesetsCli(
  root: string,
  installedCliDir: string,
): void {
  mkdirSync(join(root, 'node_modules/@changesets'), { recursive: true });
  symlinkSync(
    installedCliDir,
    join(root, 'node_modules/@changesets/cli'),
    'dir',
  );
  const exclude = join(root, '.git/info/exclude');
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, 'node_modules/\n');
}
