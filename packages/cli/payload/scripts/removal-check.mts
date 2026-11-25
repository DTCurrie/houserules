#!/usr/bin/env node
/**
 * Lists the paths the working tree deletes that no `--allow` value covers.
 *
 * Usage: removal-check.mjs [--allow <path>]...
 *
 * `--allow` repeats. A value is an exact file path or a directory prefix ending in `/`, both
 * relative to the repository root. There are no globs. Deletions come from
 * `git status --porcelain -z` over the whole tree, staged or not. A pure rename is not a
 * deletion, and a rename with edits that git reports as a delete plus an add is.
 *
 * Prints each unnamed deletion on its own line, repo-root-relative. Exit 0 is clean, 1 has
 * unnamed deletions, 2 is a usage error or a run outside a git repository.
 *
 * Not checked by this checker: whether a deletion is wanted. It only compares the tree to the
 * allow list. It never writes to the tree.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const GIT_STATUS_MAX_BYTES = 256 * 1024 * 1024;
/** A porcelain v1 entry opens with the two status columns and a space, then the path. */
const STATUS_PREFIX_LENGTH = 3;

interface RunResult {
  status: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

const USAGE = 'usage: removal-check.mjs [--allow <path>]...';

/** Collects `--allow` values, or returns the message for a malformed flag. */
function parseAllow(args: string[]): string[] | string {
  const allowed: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--allow') {
      const value = args[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return `--allow needs a path value\n${USAGE}`;
      }
      allowed.push(value);
      index += 1;
    } else if (arg.startsWith('--allow=')) {
      const value = arg.slice('--allow='.length);
      if (value === '') return `--allow needs a path value\n${USAGE}`;
      allowed.push(value);
    } else {
      return `unknown argument: ${arg}\n${USAGE}`;
    }
  }
  return allowed;
}

/** Deleted paths from NUL-separated porcelain v1 output. Paths are repo-root-relative. */
function deletedPaths(porcelain: string): string[] {
  const fields = porcelain.split('\0');
  const deleted: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] ?? '';
    if (entry.length <= STATUS_PREFIX_LENGTH) continue;
    const staged = entry[0];
    const unstaged = entry[1];
    const path = entry.slice(STATUS_PREFIX_LENGTH);
    if (
      staged === 'R' ||
      staged === 'C' ||
      unstaged === 'R' ||
      unstaged === 'C'
    ) {
      index += 1;
    }
    if (staged === 'D' || unstaged === 'D') deleted.push(path);
  }
  return deleted;
}

const covers = (allow: string, path: string): boolean =>
  allow.endsWith('/') ? path.startsWith(allow) : path === allow;

function run(args: string[], cwd: string): RunResult {
  const allowed = parseAllow(args);
  if (typeof allowed === 'string') {
    return { status: 2, stdout: '', stderr: `${allowed}\n` };
  }
  const git = spawnSync('git', ['status', '--porcelain', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_STATUS_MAX_BYTES,
  });
  if (git.error || git.status !== 0) {
    return {
      status: 2,
      stdout: '',
      stderr:
        'removal-check: could not read git status. Run it inside a git repository with git on PATH.\n',
    };
  }
  const unnamed = deletedPaths(git.stdout).filter(
    (path) => !allowed.some((allow) => covers(allow, path)),
  );
  if (unnamed.length === 0) return { status: 0, stdout: '', stderr: '' };
  return { status: 1, stdout: `${unnamed.join('\n')}\n`, stderr: '' };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  const result = run(process.argv.slice(2), process.cwd());
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
