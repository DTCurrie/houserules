import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
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
      base: root,
      loadStylesheet: async (id, base) => {
        const path =
          id === TAILWIND_PACKAGE
            ? join(tailwindDirectory, 'index.css')
            : join(base, id);
        return { base, path, content: readFileSync(path, 'utf8') };
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
