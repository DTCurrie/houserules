#!/usr/bin/env node
/**
 * Prints how many lines and files the working tree changes against a base ref, and fails past a limit.
 *
 * Usage: diff-size.mjs --base <ref> [--lines <n>] [--files <n>] [--paths <root,root>]
 *
 * `--base` is required. `--lines` defaults to 600 and `--files` to 50, and each must be a
 * positive integer. `--paths` takes a comma-separated list of path roots, relative to the
 * repository root, and counts only changes under them. A root nothing changed under counts 0.
 * Without it the whole tree counts. Lines are added plus deleted from `git diff --numstat -z -M <base>`, which
 * compares the working tree to the base, staged or not. A pure rename is 0 lines and one file.
 * A binary file adds 0 lines. Each untracked file that is not ignored counts as one file, and
 * its line count counts as additions, or 0 when it holds a NUL byte. Lock and generated files
 * count like any other, with no exclusion list. Under `--paths`, a file renamed into a root
 * from outside it counts as a new file.
 *
 * Prints exactly one line to stdout: `diff-size: <L> of <lines> lines, <F> of <files> files,
 * within budget`, or ending `over budget`. Exit 0 is within both limits, 1 is past either one,
 * 2 is a usage error, a base that does not resolve, or a run outside a git repository.
 *
 * Not checked by this script: whether the size is justified, or which files the lines are in.
 * It never writes to the tree.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const GIT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_LINE_LIMIT = 600;
const DEFAULT_FILE_LIMIT = 50;
const USAGE =
  'usage: diff-size.mjs --base <ref> [--lines <n>] [--files <n>] [--paths <root,root>]';
const FLAGS = ['--base', '--lines', '--files', '--paths'];
const NEWLINE_BYTE = 0x0a;
/** A rename entry's old and new paths follow its counts as two more NUL-separated fields. */
const RENAME_PATH_FIELDS = 2;

interface RunResult {
  status: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

interface Options {
  base: string;
  lines: number;
  files: number;
  /** Path roots the count is limited to. Empty counts the whole tree. */
  paths: string[];
}

interface Size {
  lines: number;
  files: number;
}

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;

/** Parses the flags, or returns the message for a malformed one. */
function parseArgs(args: string[]): Options | string {
  let base: string | undefined;
  let lines = DEFAULT_LINE_LIMIT;
  let files = DEFAULT_FILE_LIMIT;
  let paths: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const equalsIndex = arg.indexOf('=');
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    if (!FLAGS.includes(flag)) {
      return `unknown argument: ${arg}\n${USAGE}`;
    }
    let value: string | undefined;
    if (equalsIndex === -1) {
      value = args[index + 1];
      index += 1;
    } else {
      value = arg.slice(equalsIndex + 1);
    }
    if (value === undefined || value === '' || value.startsWith('--')) {
      return `${flag} needs a value\n${USAGE}`;
    }
    if (flag === '--base') {
      base = value;
      continue;
    }
    if (flag === '--paths') {
      paths = value.split(',').filter((root) => root !== '');
      continue;
    }
    if (!POSITIVE_INTEGER.test(value)) {
      return `${flag} must be a positive integer\n${USAGE}`;
    }
    if (flag === '--lines') lines = Number(value);
    else files = Number(value);
  }
  if (base === undefined) return `--base is required\n${USAGE}`;
  return { base, lines, files, paths };
}

/**
 * Sums `git diff --numstat -z -M` output. A rename entry is `adds\tdels\t\0old\0new\0` and every
 * other entry is `adds\tdels\tpath\0`. A binary entry has `-` counts and adds 0 lines.
 */
function numstatSize(numstat: string): Size {
  const fields = numstat.split('\0');
  let lines = 0;
  let files = 0;
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index] ?? '';
    if (entry === '') continue;
    const [added = '', deleted = '', path = ''] = entry.split('\t');
    files += 1;
    if (path === '') index += RENAME_PATH_FIELDS;
    lines += (Number(added) || 0) + (Number(deleted) || 0);
  }
  return { lines, files };
}

/** Line count of a file's bytes, or 0 when they hold a NUL byte. A last line without a newline counts. */
function countLines(bytes: Buffer): number {
  if (bytes.length === 0 || bytes.includes(0)) return 0;
  let count = 0;
  for (const byte of bytes) if (byte === NEWLINE_BYTE) count += 1;
  return bytes[bytes.length - 1] === NEWLINE_BYTE ? count : count + 1;
}

function isOverBudget(size: Size, limits: Options): boolean {
  return size.lines > limits.lines || size.files > limits.files;
}

/** The line that goes to stdout. */
function summary(size: Size, limits: Options): string {
  return `diff-size: ${size.lines} of ${limits.lines} lines, ${size.files} of ${limits.files} files, ${isOverBudget(size, limits) ? 'over' : 'within'} budget`;
}

/** Sums untracked files, each line an addition. An unreadable entry, such as a dangling symlink, counts as a file with 0 lines. */
function untrackedSize(root: string, paths: string[]): Size {
  const size = { lines: 0, files: 0 };
  for (const path of paths) {
    if (path === '') continue;
    size.files += 1;
    try {
      size.lines += countLines(readFileSync(join(root, path)));
    } catch {
      // Unreadable: counted as a file above, with no lines.
    }
  }
  return size;
}

function git(args: string[], cwd: string) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BYTES,
  });
}

function fail(stderr: string): RunResult {
  return { status: 2, stdout: '', stderr: `${stderr}\n` };
}

function run(args: string[], cwd: string): RunResult {
  const options = parseArgs(args);
  if (typeof options === 'string') return fail(options);
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (top.error || top.status !== 0) {
    return fail(
      'diff-size: could not read git state. Run it inside a git repository with git on PATH.',
    );
  }
  const root = top.stdout.trim();
  const resolved = git(
    ['rev-parse', '--verify', '--quiet', `${options.base}^{commit}`],
    root,
  );
  if (resolved.status !== 0) {
    return fail(`diff-size: base ${options.base} does not resolve`);
  }
  // `:(top,literal)` reads a root from the repository root and never as a glob.
  const scope = options.paths.map((path) => `:(top,literal)${path}`);
  const numstat = git(
    ['diff', '--numstat', '-z', '-M', options.base, '--', ...scope],
    root,
  );
  const untracked = git(
    ['ls-files', '--others', '--exclude-standard', '-z', '--', ...scope],
    root,
  );
  if (numstat.status !== 0 || untracked.status !== 0) {
    return fail('diff-size: could not read the diff.');
  }
  const tracked = numstatSize(numstat.stdout);
  const fresh = untrackedSize(root, untracked.stdout.split('\0'));
  const size = {
    lines: tracked.lines + fresh.lines,
    files: tracked.files + fresh.files,
  };
  return {
    status: isOverBudget(size, options) ? 1 : 0,
    stdout: `${summary(size, options)}\n`,
    stderr: '',
  };
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
