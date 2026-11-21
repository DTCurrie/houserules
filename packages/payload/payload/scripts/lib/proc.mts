import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, type Stats } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

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

const DISCOVERY_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_COMMON_DIR',
] as const;

const GITDIR_PREFIX = 'gitdir: ';
const FALSE_VALUES = new Set(['false', 'no', 'off', '0']);

const rootByCwd = new Map<string, string>();

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** The common directory a linked worktree's gitdir names in `commondir`, or the gitdir itself. */
function commonDirectoryOf(gitDirectory: string): string {
  const commonDirFile = readOrNull(join(gitDirectory, 'commondir'));
  return commonDirFile === null
    ? gitDirectory
    : resolve(gitDirectory, commonDirFile.trim());
}

/**
 * Whether `directory` passes git's own repository check: `HEAD` in the directory, and
 * `objects` and `refs` in its common directory.
 */
function isGitDirectory(directory: string): boolean {
  if (!existsSync(join(directory, 'HEAD'))) return false;
  const commonDir = commonDirectoryOf(directory);
  return (
    statOrNull(join(commonDir, 'objects'))?.isDirectory() === true &&
    statOrNull(join(commonDir, 'refs'))?.isDirectory() === true
  );
}

/**
 * The git directory a `.git` entry points at, or null when git would reject the entry. A
 * file must hold exactly one line, `gitdir: <path>`, resolved against the file's directory.
 */
function gitDirectoryOf(entry: string, entryStat: Stats): string | null {
  if (entryStat.isDirectory()) return isGitDirectory(entry) ? entry : null;
  const content = readOrNull(entry)?.trimEnd();
  if (!content?.startsWith(GITDIR_PREFIX) || content.includes('\n'))
    return null;
  const target = resolve(dirname(entry), content.slice(GITDIR_PREFIX.length));
  return isGitDirectory(target) ? target : null;
}

/**
 * Whether one config file sets `worktree`, or a `bare` that is not plainly false, under
 * `[core]`, or holds an `[include]` or `[includeIf]` section. The first two make git name
 * another toplevel, or none, than the directory holding `.git`. An include is not followed,
 * so it counts as unknown.
 */
function configFileMovesWorkTree(config: string): boolean {
  let isCoreSection = false;
  for (const rawLine of config.split('\n')) {
    let line = rawLine.trim();
    const header = /^\[([^\]]*)\]/.exec(line);
    if (header) {
      const sectionName = header[1]!.trim();
      if (/^include(if)?(\s|$)/i.test(sectionName)) return true;
      isCoreSection = sectionName.toLowerCase() === 'core';
      line = line.slice(header[0].length).trim();
    }
    if (!isCoreSection) continue;
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!entry) continue;
    const key = entry[1]!.toLowerCase();
    if (key === 'worktree') return true;
    const value = (entry[2] ?? 'true')
      .replace(/[#;].*$/, '')
      .trim()
      .toLowerCase();
    if (key === 'bare' && !FALSE_VALUES.has(value)) return true;
  }
  return false;
}

/**
 * Whether the repository's configs move the work tree: the gitdir's `config` and
 * `config.worktree`, and the common directory's `config` for a linked worktree. An
 * unreadable file counts as absent.
 */
function configMovesWorkTree(gitDirectory: string): boolean {
  const configPaths = new Set([
    join(gitDirectory, 'config'),
    join(gitDirectory, 'config.worktree'),
    join(commonDirectoryOf(gitDirectory), 'config'),
  ]);
  return [...configPaths].some((path) => {
    const config = readOrNull(path);
    return config !== null && configFileMovesWorkTree(config);
  });
}

function isOwnedByAnotherUser(paths: string[]): boolean {
  const currentUserId = process.getuid?.();
  if (currentUserId === undefined) return false;
  return paths.some((path) => statOrNull(path)?.uid !== currentUserId);
}

/**
 * The root the walk can answer without git, or null when git must answer. Null covers
 * every edge where the nearest `.git` entry alone would give a different answer than
 * `git rev-parse --show-toplevel`.
 */
function walkToRoot(cwd: string): string | null {
  if (DISCOVERY_ENV.some((name) => process.env[name] !== undefined))
    return null;
  if (cwd.split(sep).includes('.git')) return null;
  const cwdDevice = statOrNull(cwd)?.dev;
  if (cwdDevice === undefined) return null;
  for (let directory = cwd; ; directory = dirname(directory)) {
    if (statOrNull(directory)?.dev !== cwdDevice) return null;
    const entry = join(directory, '.git');
    const entryStat = statOrNull(entry);
    if (entryStat !== null) {
      const gitDirectory = gitDirectoryOf(entry, entryStat);
      if (gitDirectory === null) return null;
      if (isOwnedByAnotherUser([directory, entry, gitDirectory])) return null;
      if (configMovesWorkTree(gitDirectory)) return null;
      return directory;
    }
    // git also treats a directory that is itself a repository, a bare one, as the answer.
    if (isGitDirectory(directory)) return null;
    if (dirname(directory) === directory) return null;
  }
}

/**
 * The work tree root for `cwd`, or null outside one or when git cannot start. Never throws.
 *
 * Walks up from `cwd` to the first directory holding a valid `.git` entry and answers that
 * directory with no process spawned. It runs `git rev-parse --show-toplevel` instead when a
 * discovery variable (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_CEILING_DIRECTORIES`,
 * `GIT_DISCOVERY_ACROSS_FILESYSTEM`, `GIT_COMMON_DIR`) is set, the cwd is inside a `.git`,
 * the entry is invalid or owned by another user, a parent is on another device, the
 * repository's `config` or `config.worktree` sets `core.worktree` or `core.bare` or holds an
 * `[include]` or `[includeIf]` section, or no entry exists up to the filesystem root.
 *
 * Non-null answers are memoized per `cwd` for the life of the process, so a change to the
 * environment between two calls from one cwd returns the first answer.
 */
export function findRepoRoot(cwd: string = process.cwd()): string | null {
  const cached = rootByCwd.get(cwd);
  if (cached !== undefined) return cached;
  const root =
    walkToRoot(cwd) ?? git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (!root) return null;
  rootByCwd.set(cwd, root);
  return root;
}

/**
 * The repo root through `findRepoRoot()`, which answers from the filesystem when it can and
 * spawns git only on the edges it lists. Memoized per cwd.
 *
 * Falls back to `process.cwd()` when git can't answer, so a hook outside a repo still runs.
 */
export function repoRoot(): string {
  return findRepoRoot() ?? process.cwd();
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
 * separators, and when a doublestar is followed by a slash it also matches zero
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
