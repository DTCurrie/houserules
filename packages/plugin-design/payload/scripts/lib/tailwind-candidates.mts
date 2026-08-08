import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';

import {
  OXIDE_PACKAGE,
  resolveHostPackage,
} from './tailwind-host-packages.mjs';
import type { TailwindResult } from './tailwind-host-packages.mjs';

/** One class-shaped string Oxide's scanner found, with its position in the source file. */
export interface ScannedCandidate {
  candidate: string;
  /** 1-based line, matching the numbers an editor shows. */
  line: number;
  /** 1-based column, matching the numbers an editor shows. */
  column: number;
}

interface OxideCandidate {
  candidate: string;
  position: number;
}

interface ScannerInstance {
  getCandidatesWithPositions(input: {
    file: string;
    extension: string;
  }): OxideCandidate[];
}

interface OxideModule {
  Scanner: new (options: {
    sources: { base: string; pattern: string; negated: boolean }[];
  }) => ScannerInstance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasScanner(value: unknown): value is OxideModule {
  return isRecord(value) && typeof value.Scanner === 'function';
}

/**
 * Converts `position` to a 1-based line and column.
 *
 * `position` reads as a byte offset elsewhere, but measured against an accented character, an
 * emoji, CJK text, and a CRLF line ending, alone and combined, it is a plain UTF-16 code unit
 * index: `contents.slice(0, position).length` equals `position` every time, and
 * `Buffer.byteLength` does not. `\r\n` is not normalized away either, since a CRLF's `\r`
 * counts as an ordinary code unit like any other. So `contents` is indexed the same way
 * JavaScript already indexes a string, with no byte re-encoding and no line-ending rewrite.
 */
function positionToLineAndColumn(
  contents: string,
  position: number,
): { line: number; column: number } {
  const lines = contents.slice(0, position).split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/**
 * Scans `filePath` for Tailwind class candidates through `@tailwindcss/oxide`'s `Scanner`.
 *
 * The scanner is not attribute-aware and deliberately over-collects: an ordinary Svelte file
 * also yields `lang`, `const`, `isOpen`, and `true` alongside real utilities. Filtering those
 * out is `tailwind-checks.mts`'s job, through `candidatesToCss`, not this function's.
 *
 * @returns Every candidate Oxide found, or `{ ok: false, error }` naming the fix, including a
 * missing `@tailwindcss/oxide` package or a missing `filePath`.
 */
export async function scanCandidates(
  root: string,
  filePath: string,
): Promise<TailwindResult<ScannedCandidate[]>> {
  // `getCandidatesWithPositions` panics in Rust on a missing file, which aborts the whole
  // node process rather than throwing a catchable error. This check must run first.
  if (!existsSync(filePath)) {
    return {
      ok: false,
      error: `${filePath} does not exist, so it was not scanned for Tailwind class candidates.`,
    };
  }

  const resolved = resolveHostPackage(root, OXIDE_PACKAGE);
  if (!resolved.ok) return resolved;

  let importedModule: unknown;
  try {
    importedModule = await import(resolved.value.entryModuleUrl);
  } catch (error) {
    return {
      ok: false,
      error: `${OXIDE_PACKAGE} ${resolved.value.version} at ${resolved.value.entryModuleUrl} could not be imported: ${(error as Error).message}`,
    };
  }

  if (!hasScanner(importedModule)) {
    return {
      ok: false,
      error: `${OXIDE_PACKAGE} ${resolved.value.version} exports no Scanner. This plugin's Oxide shape guard has fallen out of date with an Oxide release.`,
    };
  }

  const extension = extname(filePath).replace(/^\./, '');

  // The existence check above is what stands between this call and a process-killing panic,
  // so nothing may run ahead of it that would otherwise catch a missing file first.
  let raw: OxideCandidate[];
  try {
    const scanner = new importedModule.Scanner({
      sources: [{ base: dirname(filePath), pattern: '**/*', negated: false }],
    });
    raw = scanner.getCandidatesWithPositions({ file: filePath, extension });
  } catch (error) {
    return {
      ok: false,
      error: `${filePath} could not be scanned by ${OXIDE_PACKAGE} ${resolved.value.version}: ${(error as Error).message}`,
    };
  }

  let contents: string;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: `${filePath} could not be read: ${(error as Error).message}`,
    };
  }

  return {
    ok: true,
    value: raw.map(({ candidate, position }) => ({
      candidate,
      ...positionToLineAndColumn(contents, position),
    })),
  };
}
