#!/usr/bin/env node
/**
 * Checks vitest config against the config-level clauses of `testing.md` and its guides.
 *
 * These clauses are about what a config FILE declares, not what a test asserts, so a
 * checker reads the config text rather than running the suite. Same posture as
 * `test-layout.mts`: this reports rather than tests, since a convention check written as a
 * test would be a lint rule in a test costume.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Report,
} from '@houserules/payload/findings';

const VITEST_CONFIG_NAME =
  /(^|\/)(vitest\.config|vite\.config|vitest\.workspace)\.[cm]?[jt]s$/;
const REQUIRED_SVELTE_PROJECTS = ['client', 'ssr', 'server'];

export interface FileInput {
  path: string;
  text: string;
}

const DECLINED = [
  'whether a setup file that calls requireAssertions is actually wired via setupFiles, ' +
    'since this checker reads text rather than resolving the config module',
  'a type test written with a runner other than expectTypeOf, such as tsd',
  'a vitest config that composes its projects from an imported array rather than inline ' +
    "object literals naming each project's `name`",
];

function isVitestConfig(path: string): boolean {
  return VITEST_CONFIG_NAME.test(path);
}

// Vitest turns this on two ways, both seen in the wild: an imperative call in a setup file,
// `expect.requireAssertions()`, or the config option `expect: { requireAssertions: true }`
// on `test`. A checker that only matched the call form reported 15 of 15 real vitest configs
// in this workspace as violations, every one a false positive, because this repo's own
// vitest.config.ts files all use the config-option form.
const REQUIRE_ASSERTIONS_CALL = /requireAssertions\s*\(/;
const REQUIRE_ASSERTIONS_OPTION = /requireAssertions\s*:\s*true/;

/** No assertion-free test: some passed file must turn on `requireAssertions`. */
export function checkRequireAssertions(files: FileInput[]): Report {
  const report = emptyReport();
  const configFiles = files.filter((f) => isVitestConfig(f.path));
  if (configFiles.length === 0) return report;
  const enabled = files.some(
    (f) =>
      REQUIRE_ASSERTIONS_CALL.test(f.text) ||
      REQUIRE_ASSERTIONS_OPTION.test(f.text),
  );
  if (!enabled) {
    report.findings.push({
      rule: 'testing/no-assertion-free-test-config',
      level: 'error',
      file: configFiles[0]!.path,
      line: null,
      msg: 'No vitest config or setup file turns on requireAssertions, via expect.requireAssertions() or expect: { requireAssertions: true }. An assertion-free test passes silently.',
    });
  }
  return report;
}

/** A file using `expectTypeOf` needs `typecheck: { enabled: true }` or it checks nothing. */
export function checkTypecheckEnabled(files: FileInput[]): Report {
  const report = emptyReport();
  const typeTestFiles = files.filter((f) => /expectTypeOf\s*\(/.test(f.text));
  if (typeTestFiles.length === 0) return report;
  const configFiles = files.filter((f) => isVitestConfig(f.path));
  if (configFiles.length === 0) return report;
  const enabled = configFiles.some((f) =>
    /typecheck\s*:\s*\{[^}]*enabled\s*:\s*true/s.test(f.text),
  );
  if (!enabled) {
    report.findings.push({
      rule: 'testing-typescript/typecheck-enabled',
      level: 'error',
      file: configFiles[0]!.path,
      line: null,
      msg: 'A file uses expectTypeOf but no vitest config enables typecheck: { enabled: true }. Type assertions report green while checking nothing.',
    });
  }
  return report;
}

/** A Svelte vitest config splits into `client`, `ssr`, and `server` projects. */
export function checkVitestProjectStructure(file: FileInput): Report {
  const report = emptyReport();
  if (!isVitestConfig(file.path)) return report;
  if (!/vite-plugin-svelte|svelte\s*\(/.test(file.text)) return report;
  const missing = REQUIRED_SVELTE_PROJECTS.filter(
    (name) => !new RegExp(`name:\\s*['"]${name}['"]`).test(file.text),
  );
  if (missing.length > 0) {
    report.findings.push({
      rule: 'testing-svelte/vitest-project-structure',
      level: 'error',
      file: file.path,
      line: null,
      msg: `Vitest config for a Svelte project is missing the ${missing.join(', ')} project(s). Split into client, ssr, and server projects.`,
    });
  }
  return report;
}

function readInputs(paths: string[]): FileInput[] {
  return paths.flatMap((path) => {
    try {
      return [{ path, text: readFileSync(path, 'utf8') }];
    } catch {
      return [];
    }
  });
}

function main(): void {
  const files = readInputs(process.argv.slice(2));
  const report = emptyReport();
  report.declined.push(...DECLINED);
  report.findings.push(...checkRequireAssertions(files).findings);
  report.findings.push(...checkTypecheckEnabled(files).findings);
  for (const file of files) {
    report.findings.push(...checkVitestProjectStructure(file).findings);
  }
  process.stdout.write(`${renderReport(report)}\n`);
  process.exit(exitCodeFor(report));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
