import type { RunnerBlock } from '@houserules/payload/config';
import {
  runsAtRepoRoot,
  resolveTargetCommands,
} from '@houserules/payload/config';

import type { Ctx, Target } from './detect.js';

/** eslint 10.15.0: the options `eslint --help` lists with a value. */
const ESLINT_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--config',
  '--ext',
  '--global',
  '--parser',
  '--parser-options',
  '--plugin',
  '--rule',
  '--fix-type',
  '--ignore-pattern',
  '--stdin-filename',
  '--max-warnings',
  '--output-file',
  '--format',
  '--report-unused-disable-directives-severity',
  '--report-unused-inline-configs',
  '--cache-file',
  '--cache-location',
  '--cache-strategy',
  '--suppress-rule',
  '--suppressions-location',
  '--print-config',
  '--flag',
  '--concurrency',
  '-c',
  '-o',
  '-f',
]);

/** prettier 3.10.1: the options `prettier --help` lists with a value. `-c` is `--check` and takes none. */
const PRETTIER_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--arrow-parens',
  '--embedded-language-formatting',
  '--end-of-line',
  '--experimental-operator-position',
  '--html-whitespace-sensitivity',
  '--object-wrap',
  '--parser',
  '--print-width',
  '--prose-wrap',
  '--quote-props',
  '--tab-width',
  '--trailing-comma',
  '--config',
  '--config-precedence',
  '--find-config-path',
  '--ignore-path',
  '--plugin',
  '--cursor-offset',
  '--range-end',
  '--range-start',
  '--cache-location',
  '--cache-strategy',
  '--file-info',
  '--help',
  '--log-level',
  '--stdin-filepath',
  '-h',
]);

const VALUE_FLAGS_BY_TOOL: Readonly<Record<string, ReadonlySet<string>>> = {
  eslint: ESLINT_VALUE_FLAGS,
  prettier: PRETTIER_VALUE_FLAGS,
};

const SHELL_SYNTAX = /[&|;<>$'"`\r\n]/;

/**
 * Whether a script is a bare `eslint` or `prettier` command whose every argument is a flag,
 * so appending paths after `--` makes it check those paths instead of the whole tree.
 */
export function takesPaths(script: string | undefined): boolean {
  if (typeof script !== 'string' || script.trim() === '') return false;
  if (SHELL_SYNTAX.test(script)) return false;
  const [tool, ...args] = script.trim().split(/\s+/);
  const valueFlags = tool === undefined ? undefined : VALUE_FLAGS_BY_TOOL[tool];
  if (!valueFlags) return false;
  let expectsValue = false;
  for (const arg of args) {
    if (expectsValue) {
      expectsValue = false;
      continue;
    }
    if (!arg.startsWith('-')) return false;
    expectsValue = valueFlags.has(arg);
  }
  return true;
}

/**
 * Judges the scripts the Stop hook would run. `isOn` is true when the set holds a script and
 * every script takes paths.
 */
export function passPathsDefault(
  ctx: Ctx,
  targets: readonly Pick<Target, 'pathPrefix' | 'fixCommands'>[],
  fix: RunnerBlock,
): { isOn: boolean; rejectedScripts: string[] } {
  const isAtRepoRoot = runsAtRepoRoot(fix);
  let scriptCount = 0;
  const rejectedScripts: string[] = [];
  for (const target of targets) {
    const names = resolveTargetCommands(target.fixCommands, undefined);
    if (names.length === 0) continue;
    const pathPrefix = target.pathPrefix ?? '';
    const packageJson =
      isAtRepoRoot || pathPrefix === ''
        ? ctx.rootPkg
        : ctx.packages.find((p) => `${p.relDir}/` === pathPrefix)?.pkg;
    for (const name of names) {
      scriptCount++;
      if (
        !takesPaths(packageJson?.scripts?.[name]) &&
        !rejectedScripts.includes(name)
      ) {
        rejectedScripts.push(name);
      }
    }
  }
  return {
    isOn: scriptCount > 0 && rejectedScripts.length === 0,
    rejectedScripts,
  };
}
