#!/usr/bin/env node
/**
 * Checks `package.json` wireit configuration for the mistakes a script can decide alone:
 * a script that defers to wireit with no block, a block with no script, a `files` glob
 * that walks `node_modules`, a command block missing `files` or `output`, and a
 * dependency that names a script that does not exist.
 *
 * Whether `files` covers everything the command reads, and `output` everything it writes,
 * is judgment the wireit-setup skill keeps.
 *
 * Usage: `node wireit-lint.mjs [<package.json>...]`. No arguments checks the repo root and
 * every workspace package.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRootSafe } from '@houserules/payload/config';
import {
  emptyReport,
  exitCodeFor,
  renderReport,
  type Finding,
} from '@houserules/payload/findings';
import {
  listWorkspacePackages,
  readJson,
} from '@houserules/payload/workspaces';

const DECLINED = [
  'whether a block’s `files` covers everything its command actually reads, a judgment the wireit-setup skill keeps',
  'whether a block’s `output` names everything its command actually writes, a judgment the wireit-setup skill keeps',
];

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 1-indexed line of `"key"` after the first `"section"` line, or null when not found. */
function lineOfKey(
  text: string,
  section: string | null,
  key: string,
): number | null {
  const lines = text.split('\n');
  let start = 0;
  if (section !== null) {
    const at = lines.findIndex((line) => line.includes(`"${section}"`));
    if (at === -1) return null;
    start = at + 1;
  }
  for (let i = start; i < lines.length; i++) {
    if (lines[i]!.includes(`"${key}"`)) return i + 1;
  }
  return null;
}

const GLOB_CHARS = /[*?[\]{}]/;

/** True when every segment before the first `**` is `.`, `..`, empty, or a wildcard, so no literal directory anchors it. */
function walksEverything(glob: string): boolean {
  if (glob.startsWith('!') || !glob.includes('**')) return false;
  const segments = glob.split('/');
  const firstStar = segments.findIndex((segment) => segment.includes('**'));
  return segments
    .slice(0, firstStar)
    .every(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        GLOB_CHARS.test(segment),
    );
}

function dependencyNames(block: Json): string[] {
  const deps = block.dependencies;
  if (!Array.isArray(deps)) return [];
  const out: string[] = [];
  for (const dep of deps) {
    if (typeof dep === 'string') out.push(dep);
    else if (isObject(dep) && typeof dep.script === 'string')
      out.push(dep.script);
  }
  return out;
}

/** Null when the dependency resolves, else a description of what is missing. */
function dependencyProblem(
  dep: string,
  scripts: Json,
  packageDir: string,
): string | null {
  if (!dep.startsWith('.')) {
    return dep in scripts ? null : `no script "${dep}" in this package`;
  }
  const colon = dep.indexOf(':');
  if (colon === -1) return `"${dep}" names a directory with no script`;
  const dir = dep.slice(0, colon);
  const script = dep.slice(colon + 1);
  const target = resolve(packageDir, dir, 'package.json');
  if (!existsSync(target)) return `no package.json at "${dir}"`;
  const pkg = readJson<Json>(target);
  const targetScripts = pkg && isObject(pkg.scripts) ? pkg.scripts : {};
  return script in targetScripts
    ? null
    : `"${dir}/package.json" has no script "${script}"`;
}

interface PackageContext {
  file: string;
  text: string;
  packageDir: string;
  scripts: Json;
  blocks: Json;
}

function finding(
  context: PackageContext,
  rule: string,
  level: Finding['level'],
  line: number | null,
  msg: string,
): Finding {
  return { rule: `wireit/${rule}`, level, file: context.file, line, msg };
}

/** The parsed top-level object, or a single `wireit/unreadable` finding. */
function parsePackage(
  file: string,
  text: string,
): { parsed: Json } | { problem: Finding } {
  const unreadable = (msg: string): { problem: Finding } => ({
    problem: {
      rule: 'wireit/unreadable',
      level: 'error',
      file,
      line: null,
      msg,
    },
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return unreadable(`not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) return unreadable('top level is not a JSON object');
  return { parsed };
}

function checkMissingAndOrphanBlocks(context: PackageContext): Finding[] {
  const findings: Finding[] = [];
  for (const [name, value] of Object.entries(context.scripts)) {
    if (value === 'wireit' && !(name in context.blocks)) {
      findings.push(
        finding(
          context,
          'missing-block',
          'error',
          lineOfKey(context.text, 'scripts', name),
          `script "${name}" runs wireit but has no "wireit" block named "${name}"`,
        ),
      );
    }
  }
  for (const name of Object.keys(context.blocks)) {
    if (!(name in context.scripts)) {
      findings.push(
        finding(
          context,
          'orphan-block',
          'warn',
          lineOfKey(context.text, 'wireit', name),
          `wireit block "${name}" has no script entry, so nothing runs it`,
        ),
      );
    }
  }
  return findings;
}

function checkFilesGlobs(
  context: PackageContext,
  name: string,
  block: Json,
  blockLine: number | null,
): Finding[] {
  const globs = Array.isArray(block.files)
    ? block.files.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const hasNodeModulesExclusion = globs.some(
    (glob) => glob.startsWith('!') && glob.includes('node_modules'),
  );
  if (hasNodeModulesExclusion) return [];
  return globs
    .filter(walksEverything)
    .map((glob) =>
      finding(
        context,
        'node-modules-glob',
        'error',
        lineOfKey(context.text, name, glob) ?? blockLine,
        `"${name}" files glob "${glob}" has no literal directory before \`**\` and no negated node_modules entry, so it walks node_modules`,
      ),
    );
}

function checkCommandKeys(
  context: PackageContext,
  name: string,
  block: Json,
  blockLine: number | null,
): Finding[] {
  if (typeof block.command !== 'string') return [];
  const findings: Finding[] = [];
  if (!('files' in block)) {
    findings.push(
      finding(
        context,
        'missing-files',
        'warn',
        blockLine,
        `"${name}" has a command and no "files", so wireit reruns it every time`,
      ),
    );
  }
  if (!('output' in block)) {
    findings.push(
      finding(
        context,
        'missing-output',
        'warn',
        blockLine,
        `"${name}" has a command and no "output", so wireit cannot restore or clean its results`,
      ),
    );
  }
  return findings;
}

function checkDependencies(
  context: PackageContext,
  name: string,
  block: Json,
  blockLine: number | null,
): Finding[] {
  const findings: Finding[] = [];
  for (const dep of dependencyNames(block)) {
    const problem = dependencyProblem(dep, context.scripts, context.packageDir);
    if (problem === null) continue;
    findings.push(
      finding(
        context,
        'unknown-dependency',
        'error',
        lineOfKey(context.text, name, dep) ?? blockLine,
        `"${name}" depends on "${dep}": ${problem}`,
      ),
    );
  }
  return findings;
}

function checkBlock(
  context: PackageContext,
  name: string,
  block: unknown,
): Finding[] {
  if (!isObject(block)) return [];
  const blockLine = lineOfKey(context.text, 'wireit', name);
  return [
    ...checkFilesGlobs(context, name, block, blockLine),
    ...checkCommandKeys(context, name, block, blockLine),
    ...checkDependencies(context, name, block, blockLine),
  ];
}

/**
 * Findings for one `package.json`. `file` is the repo-relative label, `absFile` the path
 * relative dependencies resolve from. Never throws on malformed input.
 */
export function checkPackageJson(
  file: string,
  absFile: string,
  text: string,
): Finding[] {
  const result = parsePackage(file, text);
  if ('problem' in result) return [result.problem];

  const { parsed } = result;
  const context: PackageContext = {
    file,
    text,
    packageDir: dirname(absFile),
    scripts: isObject(parsed.scripts) ? parsed.scripts : {},
    blocks: isObject(parsed.wireit) ? parsed.wireit : {},
  };
  return [
    ...checkMissingAndOrphanBlocks(context),
    ...Object.entries(context.blocks).flatMap(([name, block]) =>
      checkBlock(context, name, block),
    ),
  ];
}

function checkPath(root: string, path: string): Finding[] {
  const absFile = isAbsolute(path) ? path : resolve(path);
  const fromRoot = relative(root, absFile);
  const file = (
    fromRoot.startsWith('..') ? relative(process.cwd(), absFile) : fromRoot
  ).replaceAll('\\', '/');
  let text: string;
  try {
    text = readFileSync(absFile, 'utf8');
  } catch (error) {
    return [
      {
        rule: 'wireit/unreadable',
        level: 'error',
        file,
        line: null,
        msg: `could not read: ${(error as Error).message}`,
      },
    ];
  }
  return checkPackageJson(file, absFile, text);
}

function main(): void {
  const args = process.argv.slice(2);
  const root = repoRootSafe();
  let paths = args;
  if (args.length === 0) {
    if (root === null) {
      process.stderr.write(
        'wireit-lint: not inside a git work tree, nothing to check\n',
      );
      process.exit(0);
    }
    paths = [
      resolve(root, 'package.json'),
      ...listWorkspacePackages(root).map((member) =>
        resolve(member.dir, 'package.json'),
      ),
    ].filter(
      (candidate, index, all) =>
        all.indexOf(candidate) === index && existsSync(candidate),
    );
  }
  const report = emptyReport();
  report.declined.push(...DECLINED);
  for (const path of paths) {
    report.findings.push(...checkPath(root ?? process.cwd(), path));
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
