#!/usr/bin/env node
/**
 * The package linter. `node scripts/lint.js` reports, and `--fix` rewrites what it can.
 *
 * - Every `.js` file under `src/`, `test/`, and `scripts/` has no trailing whitespace and ends
 *   in exactly one newline. `--fix` repairs both.
 * - `src/index.js` re-exports every module: each `src/<name>.js` and each
 *   `src/<name>/index.js`, as `export * from './<path>';`. `--fix` cannot decide what the
 *   package exports, so it leaves this one to you.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const DIRS = ['src', 'test', 'scripts'];
const fix = process.argv.includes('--fix');

function jsFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsFiles(path);
    return name.endsWith('.js') ? [path] : [];
  });
}

function whitespaceProblems(path) {
  const text = readFileSync(path, 'utf8');
  const tidy = text.replace(/[ \t]+$/gm, '').replace(/\n*$/, '\n');
  if (tidy === text) return [];
  if (fix) {
    writeFileSync(path, tidy);
    return [];
  }
  return [`${relative(ROOT, path)}: trailing whitespace or final newline`];
}

function barrelProblems() {
  const src = join(ROOT, 'src');
  const barrel = join(src, 'index.js');
  if (!existsSync(barrel)) return ['src/index.js: missing'];
  const text = readFileSync(barrel, 'utf8');
  const modules = readdirSync(src).flatMap((name) => {
    const path = join(src, name);
    if (statSync(path).isDirectory()) {
      return existsSync(join(path, 'index.js')) ? [`./${name}/index.js`] : [];
    }
    return name.endsWith('.js') && name !== 'index.js' ? [`./${name}`] : [];
  });
  return modules
    .filter((path) => !text.includes(`export * from '${path}';`))
    .map((path) => `src/index.js: does not re-export ${path}`);
}

const problems = [
  ...DIRS.flatMap((dir) => jsFiles(join(ROOT, dir))).flatMap(
    whitespaceProblems,
  ),
  ...barrelProblems(),
];
for (const problem of problems) console.error(problem);
process.exitCode = problems.length > 0 ? 1 : 0;
