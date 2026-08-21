import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { onTestFinished } from 'vitest';

const requireFromHere = createRequire(import.meta.url);

/** The default entry stylesheet: the import Tailwind repos start from, plus a small theme. */
export const DEFAULT_ENTRY_CSS = `@import "tailwindcss";

@theme {
  --color-brand-500: oklch(0.55 0.2 265);
  --text-hero: 3rem;
  --spacing: 0.25rem;
}
`;

export interface TailwindRepoOptions {
  /** Contents of the entry stylesheet. */
  css?: string;
  /** Where the entry stylesheet goes, relative to the repo root. */
  cssPath?: string;
  /**
   * Link `@tailwindcss/oxide` as well. Off by default, because a repo can have the theme half
   * of Tailwind without the scanning half and the two detections must stay independent.
   */
  withOxide?: boolean;
}

function linkPackage(root: string, packageName: string): void {
  const manifest = requireFromHere.resolve(`${packageName}/package.json`);
  const destination = join(root, 'node_modules', packageName);
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(dirname(manifest), destination, 'dir');
}

function makeRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, type: 'module' }, null, 2)}\n`,
  );
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * A synthetic repo whose own `node_modules` holds Tailwind, removed after the current test.
 *
 * The packages are SYMLINKED from this package's dev dependencies rather than copied, so
 * `require.resolve` reports the real store path rather than one under the fixture root. Assert
 * on the version and on the behavior, never on the resolved path's prefix.
 *
 * @returns The repo root.
 */
export function useTailwindRepo(options: TailwindRepoOptions = {}): string {
  const root = makeRepo('design-tw-');
  linkPackage(root, 'tailwindcss');
  if (options.withOxide) linkPackage(root, '@tailwindcss/oxide');

  const cssPath = join(root, options.cssPath ?? 'src/app.css');
  mkdirSync(dirname(cssPath), { recursive: true });
  writeFileSync(cssPath, options.css ?? DEFAULT_ENTRY_CSS);
  return root;
}

/**
 * A synthetic repo with no Tailwind installed, removed after the current test. The other half
 * of every detection test.
 */
export function useBareRepo(): string {
  return makeRepo('design-bare-');
}

/**
 * Adds a synthetic package to `root`'s `node_modules`, for exercising package-name
 * `@import` resolution. `manifest` is spread over a minimal `{ name, version }`, and each
 * entry of `files` is written relative to the package directory.
 */
export function addPackage(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): void {
  const packageDirectory = join(root, 'node_modules', name);
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, 'package.json'),
    `${JSON.stringify({ name, version: '1.0.0', ...manifest }, null, 2)}\n`,
  );
  for (const [relative, content] of Object.entries(files)) {
    const path = join(packageDirectory, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

function copyRealPackage(destination: string, packageName: string): void {
  const manifest = requireFromHere.resolve(`${packageName}/package.json`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(dirname(manifest), destination, { recursive: true });
}

/**
 * A synthetic repo shaped like pnpm's strict layout: only `anchor` is linked at the top
 * level, and `@tailwindcss/oxide` sits beside it inside the `.pnpm` virtual store, reachable
 * only through the anchor's realpath. The store entries are real directories inside the repo
 * (copied, not symlinked out), matching where pnpm's own store lives.
 */
export function usePnpmTailwindRepo(options: { anchor?: string } = {}): string {
  const root = makeRepo('design-pnpm-');
  const anchor = options.anchor ?? 'tailwindcss';
  const storeModules = join(
    root,
    'node_modules/.pnpm',
    `${anchor.replace('/', '+')}@fixture`,
    'node_modules',
  );

  const anchorDirectory = join(storeModules, anchor);
  if (anchor === 'tailwindcss') {
    copyRealPackage(anchorDirectory, anchor);
  } else {
    mkdirSync(anchorDirectory, { recursive: true });
    writeFileSync(
      join(anchorDirectory, 'package.json'),
      `${JSON.stringify({ name: anchor, version: '4.0.0', main: 'index.js' }, null, 2)}\n`,
    );
  }
  copyRealPackage(
    join(storeModules, '@tailwindcss/oxide'),
    '@tailwindcss/oxide',
  );

  const topLevelLink = join(root, 'node_modules', anchor);
  mkdirSync(dirname(topLevelLink), { recursive: true });
  symlinkSync(anchorDirectory, topLevelLink, 'dir');

  const cssPath = join(root, 'src/app.css');
  mkdirSync(dirname(cssPath), { recursive: true });
  writeFileSync(cssPath, DEFAULT_ENTRY_CSS);
  return root;
}
