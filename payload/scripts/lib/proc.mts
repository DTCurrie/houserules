// Shared primitives for the payload hook scripts (claude-kit).
//
// These were copy-pasted across sibling scripts — `git()` in 4, stdin-JSON in 6,
// `globToRe()` and `tail()` verbatim in 2 each — so a fix to one never reached the
// others. One copy, imported everywhere.
//
// Payload rules still apply: node builtins only, no dependencies, every helper safe to
// call from a hook that must never crash. Nothing here throws; failures return null or
// a documented fallback.

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Runs git and returns its stdout, or null on any failure (not a repo, git absent,
 * non-zero exit). Never throws.
 *
 * Returns RAW output — callers that parse `status --porcelain` depend on the leading
 * two status characters, so a blanket trim here would corrupt the first line. Trim at
 * the call site when you want a single value.
 */
export function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

let cachedRoot: string | null | undefined;

/**
 * The repo root, memoized for the life of the process.
 *
 * The memo is the point: `loadConfigSafe()` resolves the root internally and the hook
 * calling it resolved the root too, so every hook invocation spawned
 * `git rev-parse --show-toplevel` twice. That is one wasted process per hook, on every
 * session start and every turn end.
 *
 * Falls back to `process.cwd()` when git can't answer, so a hook outside a repo still runs.
 */
export function repoRoot(): string {
  if (cachedRoot === undefined) {
    try {
      cachedRoot = execSync('git rev-parse --show-toplevel', {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .toString()
        .trim();
    } catch {
      cachedRoot = null;
    }
  }
  return cachedRoot || process.cwd();
}

/**
 * The hook payload Claude Code writes to stdin, or `{}` when there is none or it is
 * malformed. A hook must run even when invoked by hand with no stdin.
 */
export function readStdinJson<T = Record<string, unknown>>(): T {
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}') as T;
  } catch {
    return {} as T;
  }
}

/** The last `n` lines of `text` — used to cap command output in reports. */
export function tail(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.length <= n ? text : lines.slice(-n).join('\n');
}

/**
 * A path glob compiled to an anchored RegExp: `*` stays within one segment, `**` spans
 * separators — and when a doublestar is followed by a slash it also matches zero
 * directories — `?` is one non-separator character. Every other metacharacter is literal.
 */
export function globToRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // `**/` also matches zero dirs
      } else re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else if (c === '?') re += '[^/]';
    else re += c;
  }
  return new RegExp(`^${re}$`);
}
