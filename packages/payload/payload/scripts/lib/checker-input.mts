import { readFileSync } from 'node:fs';

import type { Finding } from './findings.mjs';

/** One file argument a checker read, with its full text. */
export interface CheckerInput {
  path: string;
  text: string;
}

/** What `readCheckerInputs` returns: the files it read, and one finding per path it could not. */
interface CheckerInputs {
  inputs: CheckerInput[];
  unreadable: Finding[];
}

/** The rule id every checker reports an unreadable file argument under. */
const UNREADABLE_INPUT_RULE = 'checker/unreadable-input';

function errorCodeOf(error: unknown): string {
  if (error instanceof Error && 'code' in error) return String(error.code);
  return 'unknown error';
}

/**
 * Reads each file argument a checker was given, in argument order.
 *
 * A path that cannot be read becomes an `error` finding rather than a silent skip, so a clean
 * report means every named file was read. That covers a mistyped path, a directory, and one
 * argument holding several paths joined by spaces. The caller pushes `unreadable` into its
 * report, and the shared exit code does the rest.
 */
export function readCheckerInputs(paths: readonly string[]): CheckerInputs {
  const inputs: CheckerInput[] = [];
  const unreadable: Finding[] = [];
  for (const path of paths) {
    try {
      inputs.push({ path, text: readFileSync(path, 'utf8') });
    } catch (error) {
      unreadable.push({
        rule: UNREADABLE_INPUT_RULE,
        level: 'error',
        file: path,
        line: null,
        msg: `Could not read this path (${errorCodeOf(error)}). Pass one existing file per argument.`,
      });
    }
  }
  return { inputs, unreadable };
}
