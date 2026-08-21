#!/usr/bin/env node
/**
 * Checks Svelte and SvelteKit files against the mechanical and hybrid clauses of
 * `svelte.md` and `sveltekit.md` that a bare-node script can decide without a Svelte or
 * TypeScript AST.
 *
 * Svelte 5 is runes-only here, and `<slot>` is superseded by snippets. That clause is
 * exact: the element either appears in the markup or it does not. Clauses about whether a
 * component is decomposed well, or whether state belongs in a rune at all, stay in the rule.
 *
 * `<slot` inside a comment or a string would be a false positive. Svelte markup has no
 * general string context at the top level, so this checks only that the match is not inside
 * an HTML comment, and declares the rest of the gap rather than pretending to close it.
 *
 * `+server.ts` and `hooks.*.ts` clauses are checked by file shape, matched on the file's own
 * path rather than its extension or content alone, since SvelteKit gives those two names a
 * meaning no ordinary `.ts` file has.
 *
 * The ESLint config clause is a config-presence question, the same posture as
 * `test-config.mts`: it reads a passed config file's text rather than resolving or running
 * ESLint itself.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Report,
} from '@houserules/payload/findings';

const SLOT_ELEMENT = /<slot[\s/>]/;
const SERVER_ROUTE_FILE = /(^|\/)\+server\.ts$/;
const HOOKS_FILE = /(^|\/)(hooks\.server|hooks\.client)\.ts$/;
const ESLINT_CONFIG_NAME = /(^|\/)eslint\.config\.[cm]?js$/;

const ALLOWED_SERVER_EXPORTS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'fallback',
  'OPTIONS',
  'HEAD',
]);

const EXPORT_NAME =
  /export\s+(?:const|let|var|function|async function)\s+([A-Za-z_$][\w$]*)/g;

const HANDLE_ERROR_EXPORT =
  /export\s+(?:const|let|var|function|async function)\s+handleError\b/;

const SVELTE_PLUGIN_IMPORT = /from\s+['"]eslint-plugin-svelte['"]/;
const SVELTE_RECOMMENDED = /svelte\.configs\.recommended/;
const VALID_COMPILE_ERROR =
  /['"]svelte\/valid-compile['"]\s*:\s*(\[\s*)?['"]error['"]/;
const NO_UNUSED_SVELTE_IGNORE_ERROR =
  /['"]svelte\/no-unused-svelte-ignore['"]\s*:\s*(\[\s*)?['"]error['"]/;

const DECLINED = [
  'whether a component is decomposed well, which the rule keeps',
  '`<slot` inside a template literal in a `<script>` block',
  'files not passed on argv, since this checker never walks the tree itself',
  'whether a repo that has no eslint-plugin-svelte import should install one at all, ' +
    'since that depends on whether the repo has any Svelte files, which this checker ' +
    'does not walk the tree to answer',
  'whether a +server.ts export named GET/POST/etc actually returns a Response, which ' +
    'needs type information this checker does not have',
  'whether handleError actually reports to a tracking service, only that it is exported',
];

export interface FileInput {
  path: string;
  text: string;
}

function withoutHtmlComments(markup: string): string {
  return markup.replace(/<!--[\s\S]*?-->/g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
}

/** Findings for one component, keyed to the clause rather than to this checker. */
export function checkComponent(file: string, markup: string): Report {
  const report = emptyReport();
  withoutHtmlComments(markup)
    .split('\n')
    .forEach((line, index) => {
      if (!SLOT_ELEMENT.test(line)) return;
      report.findings.push({
        rule: 'svelte/no-slot',
        level: 'error',
        file,
        line: index + 1,
        msg: 'Svelte 5 is runes-only here. Replace <slot> with a snippet.',
      });
    });
  return report;
}

/** `+server.ts` may only export SvelteKit's own set of HTTP-verb handler names. */
export function checkServerExports(file: FileInput): Report {
  const report = emptyReport();
  if (!SERVER_ROUTE_FILE.test(file.path)) return report;
  for (const match of file.text.matchAll(EXPORT_NAME)) {
    const name = match[1];
    if (name === undefined || ALLOWED_SERVER_EXPORTS.has(name)) continue;
    report.findings.push({
      rule: 'sveltekit/server-export-name',
      level: 'error',
      file: file.path,
      line: file.text.slice(0, match.index).split('\n').length,
      msg: `+server.ts exports "${name}", which SvelteKit's router never dispatches to. Use one of GET, POST, PUT, PATCH, DELETE, fallback, OPTIONS, HEAD.`,
    });
  }
  return report;
}

/** `hooks.server.ts` / `hooks.client.ts` must export `handleError` or errors are dropped. */
export function checkHandleError(file: FileInput): Report {
  const report = emptyReport();
  if (!HOOKS_FILE.test(file.path)) return report;
  if (HANDLE_ERROR_EXPORT.test(file.text)) return report;
  report.findings.push({
    rule: 'sveltekit/handle-error-hook',
    level: 'error',
    file: file.path,
    line: null,
    msg: 'No handleError export found. Wire the shared handleError hook to a tracking service, or unhandled errors during navigation are silently dropped.',
  });
  return report;
}

/**
 * When a flat ESLint config imports eslint-plugin-svelte, `svelte/valid-compile` and
 * `svelte/no-unused-svelte-ignore` must both be turned on at `error`, either explicitly or
 * by extending `svelte.configs.recommended` for the second one. A config that never imports
 * the plugin at all is out of scope for this checker, since that is a decision about whether
 * the repo has Svelte files, not about a config that already opted in.
 */
export function checkEslintSvelteConfig(file: FileInput): Report {
  const report = emptyReport();
  if (!ESLINT_CONFIG_NAME.test(file.path)) return report;
  if (!SVELTE_PLUGIN_IMPORT.test(file.text)) return report;
  const hasRecommended = SVELTE_RECOMMENDED.test(file.text);
  const missing: string[] = [];
  if (!VALID_COMPILE_ERROR.test(file.text))
    missing.push('svelte/valid-compile');
  if (!NO_UNUSED_SVELTE_IGNORE_ERROR.test(file.text) && !hasRecommended) {
    missing.push('svelte/no-unused-svelte-ignore');
  }
  for (const rule of missing) {
    report.findings.push({
      rule: 'svelte/eslint-config-missing-rule',
      level: 'error',
      file: file.path,
      line: null,
      msg: `eslint-plugin-svelte is imported but "${rule}" is not enabled at error.`,
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
  for (const file of files) {
    report.findings.push(...checkComponent(file.path, file.text).findings);
    report.findings.push(...checkServerExports(file).findings);
    report.findings.push(...checkHandleError(file).findings);
    report.findings.push(...checkEslintSvelteConfig(file).findings);
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
