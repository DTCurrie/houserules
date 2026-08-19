#!/usr/bin/env node
/**
 * Checks four exact syntactic clauses across the accessibility rules that a script can decide
 * without rendering or running anything: a positive `tabindex`, a titleless `<iframe>`, a Vue
 * attribute bound to the literal `false`, and an unkeyed Svelte `{#each}` block. A fifth check
 * reads `package.json` for the accessibility linter each declared framework should have.
 *
 * Every other clause in the accessibility rules stays JUDGMENT or HYBRID and is not attempted
 * here. `wcag.mts` routes markup to WCAG criteria; this checker is the first in the package that
 * actually decides one, and it decides only the four listed above.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Finding,
  type Report,
} from '@houserules/payload/findings';

const DECLINED = [
  'whether an iframe title or a tabindex value of 0/-1 is the RIGHT choice, a judgment the rule keeps',
  'whether a decorative iframe is correctly marked aria-hidden instead of titled, which needs content judgment',
  'a Vue binding whose falsy expression is not the literal string "false", since a dynamic expression cannot be evaluated statically',
  'an {#each} block whose key or filter expression contains { or }, since a stateless regex cannot balance nested braces',
  'whether an installed accessibility linter is actually wired to fail the build, only whether it appears in package.json',
  'any framework this repo declares beyond react, vue, svelte, and astro',
];

const POSITIVE_TABINDEX = /\b(?:tabindex|tabIndex)\s*=\s*["'{]?(\d+)["'}]?/g;

/** No positive `tabindex`. accessibility.md: "Use 0 or -1, or reorder the markup instead." */
export function checkTabindex(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  POSITIVE_TABINDEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = POSITIVE_TABINDEX.exec(source))) {
    const value = Number(match[1]);
    if (value <= 0) continue;
    const line = source.slice(0, match.index).split('\n').length;
    findings.push({
      rule: 'accessibility/no-positive-tabindex',
      level: 'error',
      file,
      line,
      msg: `tabindex="${value}" rewrites the tab order. Use 0 or -1, or reorder the markup instead.`,
    });
  }
  return findings;
}

const IFRAME_TAG = /<iframe\b[^>]*>/g;

/** Give every `<iframe>` a `title`. accessibility-html.md. */
export function checkIframeTitle(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  IFRAME_TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IFRAME_TAG.exec(source))) {
    if (/\btitle\s*=/.test(match[0])) continue;
    const line = source.slice(0, match.index).split('\n').length;
    findings.push({
      rule: 'accessibility-html/iframe-title',
      level: 'error',
      file,
      line,
      msg: 'iframe has no title. A screen reader has no other way to describe embedded content before entering it.',
    });
  }
  return findings;
}

const VUE_BOUND_FALSE = /(?::|v-bind:)(aria-[a-z-]+)\s*=\s*"false"/g;

/** A bound `false` still renders the attribute. accessibility-vue.md. */
export function checkVueBoundFalse(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  VUE_BOUND_FALSE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = VUE_BOUND_FALSE.exec(source))) {
    const line = source.slice(0, match.index).split('\n').length;
    findings.push({
      rule: 'accessibility-vue/bound-false-attribute',
      level: 'error',
      file,
      line,
      msg: `:${match[1]}="false" renders ${match[1]}="false" in the DOM, which is not the same as omitting the attribute. Omit the binding, or bind the whole attribute conditionally.`,
    });
  }
  return findings;
}

const EACH_BLOCK = /\{#each([^{}]*)\}/g;

/** Key `{#each}` blocks with a stable id. accessibility-svelte.md. */
export function checkEachKey(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  EACH_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EACH_BLOCK.exec(source))) {
    const body = match[1]!.trim();
    if (body.endsWith(')')) continue;
    const line = source.slice(0, match.index).split('\n').length;
    findings.push({
      rule: 'accessibility-svelte/each-key',
      level: 'error',
      file,
      line,
      msg: 'Unkeyed {#each} block. Reordering moves the underlying DOM nodes, and focus follows the node, not the list position.',
    });
  }
  return findings;
}

/**
 * A markup framework, and the accessibility linter a repo using it should have. Mirrors
 * `src/linter-check.ts`'s table, kept separate rather than imported because the payload runs on
 * bare node in a user's repo and cannot depend on this package's own `src/`.
 */
const LINTERS_BY_FRAMEWORK = [
  {
    framework: 'react',
    dependencies: ['react', 'next', 'preact'],
    install: 'eslint-plugin-jsx-a11y',
  },
  {
    framework: 'vue',
    dependencies: ['vue', 'nuxt'],
    install: 'eslint-plugin-vuejs-accessibility',
  },
  {
    framework: 'svelte',
    dependencies: ['svelte'],
    install: 'svelte-check',
  },
  {
    framework: 'astro',
    dependencies: ['astro'],
    install: 'eslint-plugin-jsx-a11y',
  },
] as const;

/** Every dependency name declared in one `package.json`'s text, or an empty set if it fails to parse. */
export function declaredDependencies(packageJsonText: string): Set<string> {
  const names = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonText);
  } catch {
    return names;
  }
  if (!parsed || typeof parsed !== 'object') return names;
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const bag = (parsed as Record<string, unknown>)[field];
    if (!bag || typeof bag !== 'object') continue;
    for (const name of Object.keys(bag)) names.add(name);
  }
  return names;
}

/** Install the accessibility linter for every framework `deps` declares. accessibility-*.md. */
export function checkA11yTooling(file: string, deps: Set<string>): Finding[] {
  const findings: Finding[] = [];
  for (const entry of LINTERS_BY_FRAMEWORK) {
    const usesFramework = entry.dependencies.some((name) => deps.has(name));
    if (!usesFramework) continue;
    if (deps.has(entry.install)) continue;
    findings.push({
      rule: `accessibility-${entry.framework}/install-linter`,
      level: 'warn',
      file,
      line: null,
      msg: `Uses ${entry.framework} with no ${entry.install} in package.json. It catches the mechanical half of the accessibility rules.`,
    });
  }
  return findings;
}

function checkMarkupFile(file: string, source: string): Finding[] {
  const findings = [
    ...checkTabindex(file, source),
    ...checkIframeTitle(file, source),
  ];
  if (file.endsWith('.vue')) findings.push(...checkVueBoundFalse(file, source));
  if (file.endsWith('.svelte')) findings.push(...checkEachKey(file, source));
  return findings;
}

function main(): void {
  const files = process.argv.slice(2);
  const report: Report = emptyReport();
  report.declined.push(...DECLINED);
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (basename(file) === 'package.json') {
      report.findings.push(
        ...checkA11yTooling(file, declaredDependencies(source)),
      );
      continue;
    }
    report.findings.push(...checkMarkupFile(file, source));
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
