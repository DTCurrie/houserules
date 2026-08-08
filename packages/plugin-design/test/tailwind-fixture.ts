import {
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
