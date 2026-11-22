/**
 * Times the steps lint-format-fix would plan for a dirty set, once each, in check mode, and
 * writes them as `fix-repro@1` JSON Lines on stdout. It changes no file in the checkout it
 * times, ignored files included: a writing flag becomes its checking form, a cache lands
 * under the OS temp directory, and pnpm's verify-deps-before-run is set to `warn`.
 *
 * Usage, from the root of the checkout, in both forms:
 *   node scripts/bench/field-repro.mjs <path>...
 *   node --input-type=module - <path>... < scripts/bench/field-repro.mjs
 *
 * One self-contained file, Node built-ins only, so it pipes over ssh. Each `<path>` is a dirty
 * file, relative to the root or absolute under it. `fix.passPaths` is treated as off.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const SCHEMA = 'fix-repro@1';
const CONFIG_PATH = '.claude/houserules.config.json';
const STDERR_EXCERPT = 300;
const STEP_TIMEOUT_MS = 600_000;
const MAX_BUFFER = 256 * 1024 * 1024;
const NANOSECONDS_PER_MILLISECOND = 1e6;
const ROOT_STEP_LABEL = '(root)';
const DEFAULT_FILTER_FLAG = '--filter';
const DEFAULT_COMMANDS = ['lint:fix', 'format:fix'];
const DEFAULT_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'svelte',
  'md',
  'json',
  'css',
  'html',
];
const SHELL_SYNTAX = /[&|;<>$`()'"\\*?{}[\]!#~]/;
const CHECK_BINARIES = new Set(['eslint', 'prettier']);
const WRITING_FLAGS = new Map([
  ['eslint', new Map([['--fix', '--fix-dry-run']])],
  [
    'prettier',
    new Map([
      ['--write', '--check'],
      ['-w', '--check'],
    ]),
  ],
]);
const EXEC_FORMS = new Map([
  ['pnpm', ['--config.verify-deps-before-run=warn', 'exec']],
  ['npm', ['exec', '--']],
  ['yarn', []],
  ['bun', ['x']],
]);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.status === 0 ? result.stdout : null;
}

function remoteOf(url) {
  if (!url) return null;
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

function rootOf(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return realpathSync(top ? top.trim() : cwd);
}

function dirtyPaths(args, root) {
  const out = [];
  for (const arg of args) {
    if (arg === '-') continue;
    const path = relative(root, isAbsolute(arg) ? arg : resolve(root, arg));
    if (path === '' || path.startsWith('..') || isAbsolute(path)) continue;
    out.push(path.split('\\').join('/'));
  }
  return out;
}

function commandsFor(target, globalCommands) {
  if (target.fixCommands === null) return [];
  if (Array.isArray(target.fixCommands)) return target.fixCommands;
  return globalCommands;
}

/** The fixer's settings, defaulted the way `resolveFixSettings` defaults them. */
function fixSettings(config) {
  const fix = config?.fix ?? {};
  const filterFlag = fix.filterFlag ?? DEFAULT_FILTER_FLAG;
  const commands = Array.isArray(fix.commands)
    ? fix.commands
    : DEFAULT_COMMANDS;
  const extensions = (config?.lintableExtensions ?? DEFAULT_EXTENSIONS).map(
    (extension) => extension.replace(/^\./, ''),
  );
  const targets = (Array.isArray(config?.targets) ? config.targets : [])
    .filter(
      (target) =>
        target?.packageName !== undefined && target?.pathPrefix !== undefined,
    )
    .map((target) => ({
      prefix: target.pathPrefix,
      name: target.packageName,
      commands: commandsFor(target, commands),
    }));
  return {
    runner: fix.runner ?? config?.packageManager ?? 'pnpm',
    filterFlag,
    runsAtRoot: !filterFlag,
    commands,
    commandExtensions: fix.commandExtensions ?? {},
    lintableExtensionPattern: new RegExp(`\\.(?:${extensions.join('|')})$`),
    generatedFilePattern: new RegExp(
      config?.generatedFilePattern ?? '/(?:CHANGELOG|BACKLOG)\\.md$',
    ),
    targets,
  };
}

function gatePasses(script, changedExtensions, commandExtensions) {
  const allowed = commandExtensions[script];
  if (!allowed?.length) return true;
  return allowed.some((extension) =>
    changedExtensions.has(String(extension).replace(/^\./, '').toLowerCase()),
  );
}

/** The lintable dirty paths grouped by owning package, each with its commands and changed extensions. */
function groupByPackage(paths, settings) {
  const byPackage = new Map();
  for (const path of paths) {
    if (!settings.lintableExtensionPattern.test(path)) continue;
    if (settings.generatedFilePattern.test(`/${path}`)) continue;
    const match = settings.targets.find((target) =>
      path.startsWith(target.prefix),
    );
    if (!match) continue;
    const entry = byPackage.get(match.name) ?? {
      commands: match.commands,
      extensions: new Set(),
    };
    entry.extensions.add((path.split('.').pop() ?? '').toLowerCase());
    byPackage.set(match.name, entry);
  }
  return byPackage;
}

/** Steps as [package, script], planned as the fixer plans them with `passPaths` off. */
function planSteps(paths, settings) {
  const byPackage = groupByPackage(paths, settings);
  let planned;
  if (settings.runsAtRoot) {
    const byScript = new Map();
    for (const { commands, extensions } of byPackage.values())
      for (const script of commands) {
        const union = byScript.get(script) ?? new Set();
        for (const extension of extensions) union.add(extension);
        byScript.set(script, union);
      }
    planned = [...byScript].map(([script, extensions]) => [
      ROOT_STEP_LABEL,
      script,
      extensions,
    ]);
  } else {
    planned = [...byPackage].flatMap(([pkg, { commands, extensions }]) =>
      commands.map((script) => [pkg, script, extensions]),
    );
  }
  return planned
    .filter(([, script, extensions]) =>
      gatePasses(script, extensions, settings.commandExtensions),
    )
    .map(([pkg, script]) => [pkg, script]);
}

/**
 * The script text a step runs. `{ kind: 'no-scripts' }` means its package.json has no scripts
 * object, and `{ kind: 'missing' }` means it defines no such script.
 */
function scriptTextOf([pkg, script], root, settings) {
  const prefix = settings.runsAtRoot
    ? ''
    : (settings.targets.find((t) => t.name === pkg)?.prefix ?? '');
  const scripts = readJson(join(root, prefix, 'package.json'))?.scripts;
  if (!scripts || typeof scripts !== 'object') return { kind: 'no-scripts' };
  if (typeof scripts[script] !== 'string') return { kind: 'missing' };
  return { kind: 'found', text: scripts[script] };
}

/**
 * The tool's argv in check mode, or null when the script is not a bare `eslint` or `prettier`
 * call. A cache flag gets a `--cache-location` under `cacheDir`.
 */
function checkTokens(text, cacheFile) {
  if (SHELL_SYNTAX.test(text)) return null;
  const tokens = text.trim().split(/\s+/);
  const binary = tokens[0]?.split('/').pop();
  if (!CHECK_BINARIES.has(binary)) return null;
  const rewrites = WRITING_FLAGS.get(binary);
  const out = [];
  let hasCache = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--cache-location') {
      i += 1;
      continue;
    }
    if (token.startsWith('--cache-location=')) continue;
    if (token === '--cache') hasCache = true;
    out.push(rewrites.get(token) ?? token);
  }
  if (hasCache) out.push(`--cache-location=${cacheFile}`);
  return out;
}

function runnerArgv(step, tokens, settings) {
  const exec = EXEC_FORMS.get(settings.runner) ?? ['exec'];
  const filter = settings.runsAtRoot ? [] : [settings.filterFlag, step[0]];
  return [...filter, ...exec, ...tokens];
}

function timeStep(argv, root, settings) {
  const started = process.hrtime.bigint();
  const result = spawnSync(settings.runner, argv, {
    cwd: root,
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_BUFFER,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  const durationMs = Math.round(
    Number(process.hrtime.bigint() - started) / NANOSECONDS_PER_MILLISECOND,
  );
  const stderr = `${result.stderr ?? ''}${result.error ? String(result.error) : ''}`;
  return {
    durationMs,
    status: result.status,
    signal: result.signal,
    stderr: stderr.slice(0, STDERR_EXCERPT),
  };
}

/** The timing line for one step, or null when its package defines no such script. */
function timingLine(step, { root, settings, remote, cacheDir }) {
  const script = scriptTextOf(step, root, settings);
  if (script.kind === 'missing') return null;
  const scriptText = script.kind === 'found' ? script.text : null;
  const tokens =
    scriptText === null
      ? null
      : checkTokens(
          scriptText,
          join(cacheDir, `${step[1].replace(/\W/g, '-')}.cache`),
        );
  const base = {
    kind: 'timing',
    schema: SCHEMA,
    remote,
    package: step[0],
    script: step[1],
    scriptText,
  };
  if (!tokens)
    return {
      ...base,
      argv: null,
      durationMs: null,
      status: null,
      signal: null,
      stderr: null,
    };
  const argv = runnerArgv(step, tokens, settings);
  return { ...base, argv, ...timeStep(argv, root, settings) };
}

function main() {
  const root = rootOf(process.cwd());
  const args = process.argv.slice(2);
  const paths = dirtyPaths(args, root);
  const config = readJson(join(root, CONFIG_PATH));
  const settings = fixSettings(config);
  const remote = remoteOf(git(root, ['remote', 'get-url', 'origin']));
  const cacheDir = mkdtempSync(join(realpathSync(tmpdir()), 'field-repro-'));

  const lines = [
    {
      kind: 'meta',
      schema: SCHEMA,
      generated: new Date().toISOString(),
      node: process.version,
      remote,
      commands: settings.commands,
      paths,
    },
  ];
  for (const step of planSteps(paths, settings)) {
    const line = timingLine(step, { root, settings, remote, cacheDir });
    if (line) lines.push(line);
  }
  process.stdout.write(
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
}

main();
