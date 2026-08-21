import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import {
  findPackageDirFrom,
  resolveHostPackage,
  TAILWIND_PACKAGE,
} from './tailwind-host-packages.mjs';
import type { TailwindResult } from './tailwind-host-packages.mjs';
import { isRecord } from './is-record.mjs';

/** Matches `@import "tailwindcss"`, the single-quote form, and a subpath such as `tailwindcss/theme`. */
const TAILWIND_IMPORT_PATTERN = /@import\s+["']tailwindcss(?:\/[^"']*)?["']/;

/**
 * `ThemeOptions.DEFAULT` from Tailwind's own theme flags: set on a token that came from
 * Tailwind's built-in palette rather than the repo's own `@theme` block.
 */
const THEME_OPTION_DEFAULT = 4;

export interface TailwindTheme {
  size: number;
  get(candidateKeys: string[]): string | null;
  getOptions(key: string): number;
  namespace(prefix: string): Map<string | null, string>;
}

export interface LoadedDesignSystem {
  entryCssPath: string;
  tailwindVersion: string;
  theme: TailwindTheme;
  candidatesToCss(candidates: string[]): (string | null)[];
}

export interface ThemeEntryCss {
  /** The entry stylesheet a caller should compile. */
  path: string;
  /** Any further files that also import Tailwind, so a caller can report the count. */
  alternates: string[];
}

function shapeGuardMessage(member: string, version: string): string {
  return (
    `Tailwind ${version}'s loaded design system has no ${member}. This plugin's ` +
    `\`__unstable__loadDesignSystem\` shape guard has fallen out of date with a Tailwind release. ` +
    `The documented fallback is the public \`compile(css).build(candidates)\` API.`
  );
}

interface UnstableModule {
  __unstable__loadDesignSystem: (
    css: string,
    options: {
      base: string;
      loadStylesheet: (
        id: string,
        base: string,
      ) => Promise<{ base: string; path: string; content: string }>;
    },
  ) => Promise<unknown>;
}

function hasLoadDesignSystem(value: unknown): value is UnstableModule {
  return (
    isRecord(value) && typeof value.__unstable__loadDesignSystem === 'function'
  );
}

function validateDesignSystemShape(
  value: unknown,
  version: string,
): string | undefined {
  if (!isRecord(value))
    return shapeGuardMessage('a design system object', version);

  const theme = value.theme;
  if (!isRecord(theme)) return shapeGuardMessage('theme', version);
  if (typeof theme.size !== 'number')
    return shapeGuardMessage('theme.size', version);
  if (typeof theme.get !== 'function')
    return shapeGuardMessage('theme.get', version);
  if (typeof theme.getOptions !== 'function') {
    return shapeGuardMessage('theme.getOptions', version);
  }
  if (typeof theme.namespace !== 'function') {
    return shapeGuardMessage('theme.namespace', version);
  }
  if (typeof value.candidatesToCss !== 'function') {
    return shapeGuardMessage('candidatesToCss', version);
  }

  return undefined;
}

/**
 * Picks the entry stylesheet out of every CSS file the caller collected, by finding the one
 * that imports Tailwind. This lib walks no directories itself: the caller already has the full
 * file list, per the composition-root split this repo keeps between scripts and libs.
 *
 * @returns The first matching path, plus any further matches as `alternates` so a caller can
 * report the count rather than silently picking one.
 */
export function findThemeEntryCss(
  cssFilePaths: string[],
): TailwindResult<ThemeEntryCss> {
  const matches: string[] = [];
  const unreadable: string[] = [];
  for (const path of cssFilePaths) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      unreadable.push(path);
      continue;
    }
    if (TAILWIND_IMPORT_PATTERN.test(text)) matches.push(path);
  }

  const [path, ...alternates] = matches;
  if (path === undefined) {
    if (unreadable.length > 0) {
      return {
        ok: false,
        error: `${unreadable.length} of ${cssFilePaths.length} CSS file(s) could not be read (e.g. ${unreadable[0]}), so tailwindcss could not be located among them.`,
      };
    }
    return {
      ok: false,
      error: `No CSS file imports "tailwindcss" among ${cssFilePaths.length} file(s) checked.`,
    };
  }

  return { ok: true, value: { path, alternates } };
}

/** Splits a package specifier into its package name and optional subpath. */
function splitSpecifier(id: string): { packageName: string; subpath: string } {
  const segments = id.split('/');
  const nameSegmentCount = id.startsWith('@') ? 2 : 1;
  return {
    packageName: segments.slice(0, nameSegmentCount).join('/'),
    subpath: segments.slice(nameSegmentCount).join('/'),
  };
}

function styleEntryFromExports(exportsField: unknown): string | undefined {
  const dot =
    isRecord(exportsField) && '.' in exportsField
      ? exportsField['.']
      : exportsField;
  if (typeof dot === 'string') return dot.endsWith('.css') ? dot : undefined;
  if (isRecord(dot)) {
    const condition = dot.style ?? dot.default;
    if (typeof condition === 'string' && condition.endsWith('.css'))
      return condition;
  }
  return undefined;
}

/**
 * The CSS file a package specifier names, dependency-free: a subpath is tried literally and
 * with `.css` appended, and a bare package name goes through the `exports` "." style
 * condition, then the `style` field, then a `main` naming a `.css`, then `index.css`. The
 * style condition first matches Tailwind's own resolver, so a package behaves here as it
 * does under the host's real build.
 */
function resolveCssEntry(
  packageDirectory: string,
  subpath: string,
): string | undefined {
  if (subpath) {
    const literal = join(packageDirectory, subpath);
    if (existsSync(literal)) return literal;
    const withExtension = `${literal}.css`;
    return existsSync(withExtension) ? withExtension : undefined;
  }
  let manifest: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(packageDirectory, 'package.json'), 'utf8'),
    );
    if (isRecord(parsed)) manifest = parsed;
  } catch {
    // No readable manifest: fall through to the index.css convention.
  }
  const candidates = [
    styleEntryFromExports(manifest.exports),
    typeof manifest.style === 'string' ? manifest.style : undefined,
    typeof manifest.main === 'string' && manifest.main.endsWith('.css')
      ? manifest.main
      : undefined,
    'index.css',
  ];
  for (const relative of candidates) {
    if (relative === undefined) continue;
    const path = join(packageDirectory, relative);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * The file an `@import` id names. A relative or absolute id stays a filesystem path.
 * Anything else is a package specifier, located by walking `node_modules` up from the
 * importing stylesheet's own directory, so a shared tokens package resolves here the same
 * way the host's bundler resolves it.
 *
 * @throws When the specifier resolves to nothing. The compile wrapper in
 * {@link loadDesignSystem} turns the message into its `ok: false` result.
 */
function resolveStylesheet(
  id: string,
  base: string,
  tailwindDirectory: string,
): string {
  if (id.startsWith('.')) return join(base, id);
  if (isAbsolute(id)) return id;
  const { packageName, subpath } = splitSpecifier(id);
  // The tailwindDirectory fallback keeps the pre-package-resolution guarantee: the entry
  // `@import "tailwindcss"` resolves even when the entry stylesheet sits outside any
  // node_modules tree that holds Tailwind.
  const packageDirectory =
    findPackageDirFrom(base, packageName) ??
    (packageName === TAILWIND_PACKAGE ? tailwindDirectory : undefined);
  if (packageDirectory === undefined) {
    throw new Error(
      `@import "${id}" names a package that is not installed (looked in node_modules upward from ${base}).`,
    );
  }
  const entry = resolveCssEntry(packageDirectory, subpath);
  if (entry === undefined) {
    throw new Error(
      `@import "${id}" resolved to ${packageDirectory}, but no stylesheet was found there${subpath ? ` for "${subpath}"` : ''}.`,
    );
  }
  return entry;
}

/**
 * Loads the host repo's own resolved Tailwind design system: the compiled theme plus a
 * candidate-to-CSS checker, both backed by the repo's real `@theme` block and utilities.
 *
 * Every failure path, a missing package, an unreadable stylesheet, a compile error, or an
 * unexpected Tailwind shape, returns `{ ok: false, error }` naming the fix. Nothing here throws.
 */
export async function loadDesignSystem(
  root: string,
  entryCssPath: string,
): Promise<TailwindResult<LoadedDesignSystem>> {
  const resolved = resolveHostPackage(root, TAILWIND_PACKAGE);
  if (!resolved.ok) return resolved;

  let cssText: string;
  try {
    cssText = readFileSync(entryCssPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: `${entryCssPath} could not be read: ${(error as Error).message}`,
    };
  }

  let importedModule: unknown;
  try {
    importedModule = await import(resolved.value.entryModuleUrl);
  } catch (error) {
    return {
      ok: false,
      error: `${TAILWIND_PACKAGE} ${resolved.value.version} at ${resolved.value.entryModuleUrl} could not be imported: ${(error as Error).message}`,
    };
  }

  if (!hasLoadDesignSystem(importedModule)) {
    return {
      ok: false,
      error: shapeGuardMessage(
        '__unstable__loadDesignSystem',
        resolved.value.version,
      ),
    };
  }

  const tailwindDirectory = resolved.value.directory;

  let loaded: unknown;
  try {
    loaded = await importedModule.__unstable__loadDesignSystem(cssText, {
      base: dirname(entryCssPath),
      loadStylesheet: async (id, base) => {
        const path = resolveStylesheet(id, base, tailwindDirectory);
        return {
          base: dirname(path),
          path,
          content: readFileSync(path, 'utf8'),
        };
      },
    });
  } catch (error) {
    return {
      ok: false,
      error: `${entryCssPath} could not be compiled by Tailwind ${resolved.value.version}: ${(error as Error).message}`,
    };
  }

  const shapeError = validateDesignSystemShape(loaded, resolved.value.version);
  if (shapeError !== undefined) return { ok: false, error: shapeError };

  const system = loaded as {
    theme: TailwindTheme;
    candidatesToCss: (candidates: string[]) => (string | null)[];
  };

  return {
    ok: true,
    value: {
      entryCssPath,
      tailwindVersion: resolved.value.version,
      theme: system.theme,
      // Called through `system` rather than handed over detached, so it keeps its receiver if a
      // Tailwind release ever moves it from an instance property onto the prototype.
      candidatesToCss: (candidates) => system.candidatesToCss(candidates),
    },
  };
}

/** True when `key` was declared by the repo's own `@theme` block, not Tailwind's default palette. */
export function isRepoDefinedThemeKey(
  theme: TailwindTheme,
  key: string,
): boolean {
  return (theme.getOptions(key) & THEME_OPTION_DEFAULT) === 0;
}
