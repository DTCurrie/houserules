import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CheckResult, Ctx, Finding } from '@agent-kit/api';

const TAILWIND_MAJOR = 4;

/**
 * Host packages the `design-tailwind` module needs. Kept in step with
 * `payload/scripts/lib/tailwind-host-packages.mts`, which is the copy the module itself
 * resolves at runtime. Two lists is one more than ideal, but the payload may not import from
 * `src/` and the CLI may not import from the payload, so neither can hold the other's copy.
 */
const TAILWIND_PACKAGES = [
  {
    name: 'tailwindcss',
    installHint: 'npm install -D tailwindcss@^4',
    purpose: 'theme queries',
  },
  {
    name: '@tailwindcss/oxide',
    installHint:
      'npm install -D @tailwindcss/vite@^4 (or @tailwindcss/postcss, or @tailwindcss/cli)',
    purpose: 'class-name scanning',
  },
] as const;

interface ResolvedPackage {
  version: string;
  major: number;
}

type PackageResolution =
  | { status: 'not-found' }
  | { status: 'unreadable'; manifestPath: string }
  | ({ status: 'resolved' } & ResolvedPackage);

/**
 * Finds `node_modules/<packageName>/package.json` by walking from `root` up through its
 * ancestor directories, stopping at the filesystem root.
 *
 * `require.resolve` was tried first and rejected: it also searches `NODE_PATH` and the global
 * `$HOME/.node_modules` folders, which a package manager's own tooling can populate, so it can
 * report a package as present when it is only on the machine and not in this host's own
 * dependency tree. Walking `node_modules` directories by hand scopes the search to the host.
 */
function findPackageManifest(
  root: string,
  packageName: string,
): string | undefined {
  let directory = root;
  for (;;) {
    const candidate = join(
      directory,
      'node_modules',
      packageName,
      'package.json',
    );
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function resolvePackageVersion(
  root: string,
  packageName: string,
): PackageResolution {
  const manifestPath = findPackageManifest(root, packageName);
  if (!manifestPath) return { status: 'not-found' };

  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (
      typeof manifest !== 'object' ||
      manifest === null ||
      !('version' in manifest) ||
      typeof manifest.version !== 'string'
    ) {
      return { status: 'unreadable', manifestPath };
    }
    const major = Number.parseInt(manifest.version.split('.')[0] ?? '', 10);
    if (Number.isNaN(major)) return { status: 'unreadable', manifestPath };
    return { status: 'resolved', version: manifest.version, major };
  } catch {
    return { status: 'unreadable', manifestPath };
  }
}

/**
 * Reports whether the host repo has the Tailwind packages `design-tailwind` needs.
 *
 * `tailwindcss` and `@tailwindcss/oxide` are reported independently: `@tailwindcss/oxide` is
 * not a dependency of `tailwindcss` and arrives separately with `@tailwindcss/vite`,
 * `@tailwindcss/postcss`, or the CLI, so a repo can have one without the other. Every finding
 * is a WARN, never an ERROR, since a repo without Tailwind is a reduced install rather than a
 * broken one, and the plugin's other checks work without it.
 */
export function checkTailwindAvailable(ctx: Ctx): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];

  for (const tailwindPackage of TAILWIND_PACKAGES) {
    const resolved = resolvePackageVersion(ctx.root, tailwindPackage.name);
    if (resolved.status === 'not-found') {
      findings.push({
        level: 'WARN',
        msg: `design: ${tailwindPackage.name} not found, so ${tailwindPackage.purpose} is unavailable to design-tailwind. Install it: ${tailwindPackage.installHint}`,
      });
      continue;
    }

    if (resolved.status === 'unreadable') {
      findings.push({
        level: 'WARN',
        msg: `design: ${tailwindPackage.name}'s package.json at ${resolved.manifestPath} could not be parsed, so its version could not be confirmed. Reinstall it: ${tailwindPackage.installHint}`,
      });
      continue;
    }

    if (resolved.major !== TAILWIND_MAJOR) {
      findings.push({
        level: 'WARN',
        msg: `design: ${tailwindPackage.name}@${resolved.version} found, but design-tailwind only supports major ${TAILWIND_MAJOR}. Install it: ${tailwindPackage.installHint}`,
      });
      continue;
    }

    readouts.push(`design: ${tailwindPackage.name}@${resolved.version} found`);
  }

  return { findings, readouts };
}
