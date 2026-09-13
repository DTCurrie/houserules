#!/usr/bin/env node
/**
 * Checks test file placement and naming against the structural clauses of `testing.md`.
 *
 * Only clauses about where a file sits and what it is called land here. Those are exact,
 * because the answer is in the path. Clauses about what a test should assert stay in the
 * rule, because no amount of path inspection reaches them.
 *
 * This deliberately reports rather than tests. `testing.md`'s own position is that a test
 * asserts production behaviour and never asserts a repo convention, so a convention check
 * written as a test would be a lint rule in a test costume. It is a checker.
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Report,
} from '@houserules/payload/findings';

const E2E_TIER = /\.e2e\.test\.[cm]?[jt]sx?$/;
const TEST_SUFFIX = /\.test\.[cm]?[jt]sx?$/;
const SPEC_SUFFIX = /\.spec\.[cm]?[jt]sx?$/;

const DECLINED = [
  "what a test asserts, which is the rule's subject and not a path question",
  'whether a file sitting outside the configured test directory is genuinely about the ' +
    'unit beside it, so checkColocation only requires that directory itself, never a ' +
    'matching sibling subject file: a real corpus check found 40% of test files name a ' +
    'tree or a concept rather than one file, which the rule text itself calls a judgment call',
  'files not passed on argv, since the placement and naming checks never walk the tree ' +
    'themselves; only a directory argument is walked, for the build-output check',
];

/** Findings for one path, keyed to the clause rather than to this checker. */
export function checkPath(file: string): Report {
  const report = emptyReport();
  if (E2E_TIER.test(file)) {
    report.findings.push({
      rule: 'testing/no-e2e-tier',
      level: 'error',
      file,
      line: null,
      msg: 'Never add a .e2e.test tier. Split by subject, not by unit-versus-e2e.',
    });
  }
  return report;
}

/** A test file must sit inside the configured test directory, not loose beside its subject. */
export function checkColocation(file: string, testDir = '__tests__'): Report {
  const report = emptyReport();
  if (!TEST_SUFFIX.test(file) && !SPEC_SUFFIX.test(file)) return report;
  const segments = file.split('/');
  if (segments.at(-2) !== testDir) {
    report.findings.push({
      rule: 'testing/test-colocation',
      level: 'error',
      file,
      line: null,
      msg: `Test file does not sit inside a ${testDir} directory beside the code it covers.`,
    });
  }
  return report;
}

/**
 * The configured test directory holds tests, not fixtures or setup. `__snapshots__` is
 * excluded, since Vitest writes that subdirectory itself rather than an author placing a
 * fixture there.
 */
export function checkDirContents(file: string, testDir = '__tests__'): Report {
  const report = emptyReport();
  const segments = file.split('/');
  if (!segments.includes(testDir)) return report;
  if (segments.includes('__snapshots__')) return report;
  if (TEST_SUFFIX.test(file) || SPEC_SUFFIX.test(file)) return report;
  report.findings.push({
    rule: 'testing/test-dir-contents',
    level: 'error',
    file,
    line: null,
    msg: `Non-test file inside a ${testDir} directory. Shared fixtures and setup belong in a plainly named test/ directory, not ${testDir}/.`,
  });
  return report;
}

/** Walks up from `file` to the nearest ancestor directory holding a `package.json`. */
function nearestPackageDir(file: string): string {
  let dir = dirname(file);
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return '.';
    dir = parent;
  }
}

/** One suffix per package, `.test.` or `.spec.`, never both. Grouped by nearest `package.json`. */
export function checkSuffixConsistency(files: string[]): Report {
  const report = emptyReport();
  const groups = new Map<
    string,
    { testFiles: string[]; specFiles: string[] }
  >();
  for (const file of files) {
    if (!TEST_SUFFIX.test(file) && !SPEC_SUFFIX.test(file)) continue;
    const dir = nearestPackageDir(file);
    const group = groups.get(dir) ?? { testFiles: [], specFiles: [] };
    if (TEST_SUFFIX.test(file)) group.testFiles.push(file);
    else group.specFiles.push(file);
    groups.set(dir, group);
  }
  for (const [dir, { testFiles, specFiles }] of groups) {
    if (testFiles.length === 0 || specFiles.length === 0) continue;
    const minority =
      testFiles.length <= specFiles.length ? testFiles : specFiles;
    report.findings.push({
      rule: 'testing-typescript/test-suffix-consistency',
      level: 'error',
      file: minority[0]!,
      line: null,
      msg: `Package ${dir} mixes .test. and .spec. suffixes: ${testFiles.length} .test. file(s), ${specFiles.length} .spec. file(s). Pick one suffix per package and rename the minority.`,
    });
  }
  return report;
}

const SKIP_DIRS = new Set(['node_modules', '.git']);

function walk(dir: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (SKIP_DIRS.has(entry.name)) return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Walks an already-built output directory for a leaked test file or `__tests__` directory. */
export function checkBuildOutput(dir: string): Report {
  const report = emptyReport();
  for (const file of walk(dir)) {
    const segments = file.split('/');
    if (
      segments.includes('__tests__') ||
      TEST_SUFFIX.test(file) ||
      SPEC_SUFFIX.test(file)
    ) {
      report.findings.push({
        rule: 'testing-typescript/build-output-test-leakage',
        level: 'error',
        file,
        line: null,
        msg: 'Test file leaked into the build output. Exclude tests from the build config.',
      });
    }
  }
  return report;
}

function main(): void {
  const report = emptyReport();
  report.declined.push(...DECLINED);
  let testDir = '__tests__';
  const files: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--test-dir') {
      testDir = argv[++i] ?? testDir;
      continue;
    }
    if (arg.startsWith('--test-dir=')) {
      testDir = arg.slice('--test-dir='.length);
      continue;
    }
    let isDirectory: boolean;
    try {
      isDirectory = statSync(arg).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (isDirectory) {
      report.findings.push(...checkBuildOutput(arg).findings);
    } else {
      files.push(arg);
    }
  }
  for (const file of files) {
    report.findings.push(...checkPath(file).findings);
    report.findings.push(...checkColocation(file, testDir).findings);
    report.findings.push(...checkDirContents(file, testDir).findings);
  }
  report.findings.push(...checkSuffixConsistency(files).findings);
  process.stdout.write(`${renderReport(report)}\n`);
  process.exit(exitCodeFor(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
