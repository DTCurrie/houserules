import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { sandboxEnv } from './sandbox-env.mjs';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'hooks',
);

const SCRIPT_RE = /\.claude\/scripts\/([\w.-]+)\.mjs/;

const SOURCE_FILE = 'packages/app/src/index.mjs';
const CLEAN_SOURCE = 'export const answer = 42;\n';
const DIRTY_SOURCE = 'export const answer = 43;\n';

// Stands in for the fixer: the hooks run `pnpm run lint:fix` and `format`, which here do nothing.
const NO_OP_FIX_SCRIPT = 'node -e 0';

const BUILD_MARKER = '.bench-build.json';
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const SKIPPED_MODULES_ENTRY = '.cache';

// A source file the scope cases edit: a tracked `.ts` directly under some `packages/<name>/src/`.
const SCOPE_SOURCE_RE = /^packages\/([^/]+)\/src\/(?!.*\.d\.ts$)[^/]+\.ts$/;
const SCOPE_HOOK_COMMAND =
  'exec node "$CLAUDE_PROJECT_DIR/.claude/scripts/lint-format-fix.mjs"';
const SCOPE_EDIT_DIRTY = 'export const   benchScope  =  1 ;';
const SCOPE_TIMEOUT_MS = 300_000;

// `off` runs this repo's whole-tree scripts, `on` the path-taking ones, and `on-dot` the whole-tree
// scripts with `passPaths` on, which is the widening the schema warns of.
const SCOPE_ARMS = [
  { name: 'off', commands: ['lint:fix', 'format:fix'], passPaths: false },
  {
    name: 'on',
    commands: ['lint:fix:paths', 'format:paths'],
    passPaths: true,
  },
  { name: 'on-dot', commands: ['lint:fix', 'format:fix'], passPaths: true },
];

const SCOPE_PATH_SCRIPTS = {
  'lint:fix:paths': 'eslint --fix',
  'format:paths': 'prettier --cache --write',
};

const BACKLOG_ID = 'BENCH-a1b2c3';

// Observed, not assumed: on the dirty tree changeset-check nudges with exit 2, every other Stop hook exits 0.
const DIRTY_EXIT = { 'changeset-check': [2] };

const CONFIG = {
  version: 2,
  packageManager: 'pnpm',
  fix: {
    runner: 'pnpm',
    filterFlag: '',
    runScriptPrefix: ['run'],
    commands: ['lint:fix', 'format'],
  },
  verify: {
    runner: 'pnpm',
    filterFlag: '--filter',
    runScriptPrefix: ['run'],
    commands: ['check', 'test'],
  },
  guard: {
    gitCommit: true,
    gitPush: true,
    gitStash: true,
    gitDiscard: true,
    prCreate: true,
    custom: [],
  },
  changesets: { enabled: true, stopCheck: true, baseBranch: 'main' },
  targets: [
    {
      name: 'app',
      prefix: 'APP',
      packageName: '@bench/app',
      pathPrefix: 'packages/app/',
      sourcePath: 'packages/app/src',
      label: 'App',
      verifyCommands: ['check', 'test'],
    },
  ],
};

function kebab(event) {
  return event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function git(cwd, args, env) {
  const result = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
}

const DISPATCHER_SCRIPT = 'hook-dispatch';

/**
 * Each hook to bench, in settings order, with its event and script name. A dispatcher entry
 * expands to the scripts `wiring` lists for its event, each run directly, so the dispatcher is
 * never a case. A direct entry keeps its own command.
 */
function wiredHooks(settings, wiring) {
  const out = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (hook.type !== 'command') continue;
        const match = SCRIPT_RE.exec(hook.command);
        if (!match)
          throw new Error(
            `hooks suite: no .claude/scripts/<name>.mjs in the ${event} command ${hook.command}`,
          );
        if (match[1] !== DISPATCHER_SCRIPT) {
          out.push({ event, script: match[1], command: hook.command });
          continue;
        }
        for (const entry of wiring.events[event] ?? []) {
          const script = entry.script.replace(/\.mjs$/, '');
          out.push({
            event,
            script,
            command: `exec node "$CLAUDE_PROJECT_DIR/.claude/scripts/${script}.mjs"`,
          });
        }
      }
    }
  }
  return out;
}

function payloadScriptDirs(root) {
  const packages = join(root, 'packages');
  return readdirSync(packages)
    .map((name) => join(packages, name, 'payload-dist', 'scripts'))
    .filter((dir) => existsSync(dir));
}

/**
 * Lays scripts out the way an install does: each hook script at `.claude/scripts/<name>.mjs`
 * and every payload lib flat under `.claude/scripts/lib/`, without the `.d.mts` declarations.
 */
function installScripts(root, scripts, dest) {
  const dirs = payloadScriptDirs(root);
  mkdirSync(join(dest, 'lib'), { recursive: true });
  for (const dir of dirs) {
    const lib = join(dir, 'lib');
    if (!existsSync(lib)) continue;
    for (const file of readdirSync(lib))
      if (file.endsWith('.mjs'))
        copyFileSync(join(lib, file), join(dest, 'lib', file));
  }
  for (const script of new Set(scripts)) {
    const found = dirs
      .map((dir) => join(dir, `${script}.mjs`))
      .filter((path) => existsSync(path));
    if (found.length !== 1)
      throw new Error(
        `hooks suite: expected one built ${script}.mjs under ${root}/packages/*/payload-dist/scripts, found ${found.length}`,
      );
    copyFileSync(found[0], join(dest, `${script}.mjs`));
  }
}

function backlogLedger() {
  const body = [
    `## [${BACKLOG_ID}] Stop hook reruns the fixer on an unchanged tree`,
    '',
    '- **Area:** app',
    '',
    'The fixer runs even when the turn changed nothing it lints. Gate it on the changed extensions.',
    '',
  ].join('\n');
  const record = {
    ts: '2026-01-01T00:00:00.000Z',
    id: BACKLOG_ID,
    action: 'add',
    file: 'BACKLOG.md',
    title: 'Stop hook reruns the fixer on an unchanged tree',
    chat: 'none',
    content: gzipSync(Buffer.from(body)).toString('base64'),
  };
  return `${JSON.stringify(record)}\n`;
}

function buildProject(root, scripts, project, env) {
  write(
    join(project, 'package.json'),
    json({
      name: 'bench-fixture',
      private: true,
      scripts: { 'lint:fix': NO_OP_FIX_SCRIPT, format: NO_OP_FIX_SCRIPT },
    }),
  );
  write(join(project, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  write(
    join(project, '.gitignore'),
    'node_modules/\n.claude/scripts/\n.claude/state/\n.claude/ledgers/\n',
  );
  write(
    join(project, 'packages/app/package.json'),
    json({
      name: '@bench/app',
      version: '0.0.0',
      type: 'module',
      files: ['src'],
    }),
  );
  write(join(project, SOURCE_FILE), CLEAN_SOURCE);
  write(
    join(project, '.changeset/config.json'),
    json({ baseBranch: 'main', ignore: [] }),
  );
  write(join(project, '.claude/houserules.config.json'), json(CONFIG));
  write(join(project, '.claude/ledgers/backlog.jsonl'), backlogLedger());
  installScripts(root, scripts, join(project, '.claude/scripts'));
  git(project, ['init', '-q', '-b', 'main'], env);
  git(project, ['config', 'user.name', 'bench'], env);
  git(project, ['config', 'user.email', 'bench@example.invalid'], env);
  git(project, ['add', '-A'], env);
  git(project, ['commit', '-q', '-m', 'fixture'], env);
}

/** Puts the fixture at its commit, drops hook state, and leaves one source edit when `isDirty`. */
function resetTree(project, env, isDirty) {
  git(project, ['reset', '-q', '--hard', 'HEAD'], env);
  git(project, ['clean', '-fdq'], env);
  rmSync(join(project, '.claude/state'), { recursive: true, force: true });
  if (isDirty) writeFileSync(join(project, SOURCE_FILE), DIRTY_SOURCE);
}

function payloadFor(event, project, transcript) {
  const payload = JSON.parse(
    readFileSync(join(FIXTURES, `${kebab(event)}.json`), 'utf8'),
  );
  payload.cwd = project;
  payload.transcript_path = transcript;
  return JSON.stringify(payload);
}

/** The environment every hook case runs under. */
export function hookCaseEnv(home, project) {
  return {
    ...sandboxEnv(home),
    CLAUDE_PROJECT_DIR: project,
    pnpm_config_verify_deps_before_run: 'false',
  };
}

function prepareFixture({ root, workDir, hooks }) {
  const project = join(workDir, 'project');
  const home = join(workDir, 'home');
  const transcript = join(workDir, 'transcript.jsonl');
  mkdirSync(home, { recursive: true });
  copyFileSync(join(FIXTURES, 'transcript.jsonl'), transcript);

  const env = hookCaseEnv(home, project);
  buildProject(
    root,
    hooks.map((hook) => hook.script),
    project,
    env,
  );
  return { project, transcript, env };
}

function casesForHook(hook, { project, transcript, env }) {
  const caseFor = ({ name, isDirty, expectExit }) => ({
    name,
    command: '/bin/sh',
    args: ['-c', hook.command],
    cwd: project,
    env,
    stdin: payloadFor(hook.event, project, transcript),
    expectExit,
    beforeEach: () => resetTree(project, env, isDirty),
  });

  if (hook.event !== 'Stop') {
    return [caseFor({ name: hook.script, isDirty: false, expectExit: [0] })];
  }
  return [
    caseFor({
      name: `stop-${hook.script}-clean`,
      isDirty: false,
      expectExit: [0],
    }),
    caseFor({
      name: `stop-${hook.script}-dirty`,
      isDirty: true,
      expectExit: DIRTY_EXIT[hook.script] ?? [0],
    }),
  ];
}

/**
 * The build tree's own `.claude/settings.json` and `.claude/scripts/hook-wiring.json`, which its
 * dogfood step wrote, so the wiring never names a script the build lacks. A tree with no
 * dispatcher wiring file gets empty wiring, and a tree with no settings throws.
 */
function readBuildWiring(root) {
  const settingsPath = join(root, '.claude', 'settings.json');
  if (!existsSync(settingsPath))
    throw new Error(
      `hooks suite: ${settingsPath} is missing. The build's dogfood step writes it, so rebuild this tree.`,
    );
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const wiringPath = join(root, '.claude', 'scripts', 'hook-wiring.json');
  const wiring = existsSync(wiringPath)
    ? JSON.parse(readFileSync(wiringPath, 'utf8'))
    : { events: {} };
  return { settings, wiring };
}

/**
 * One case per hook command wired in `<root>/.claude/settings.json`, each run through
 * `/bin/sh -c` with the exact command string, fed the stdin payload Claude Code sends for its
 * event, against a fixture project whose `.claude/scripts/` is assembled from the build tree's
 * `packages/*\/payload-dist/scripts/`. Settings, wiring, and scripts all come from `root`, so
 * the wiring and the scripts it names are always one revision. Stop hooks get two cases, a
 * clean tree and one with an uncommitted source edit. Every case resets the fixture in
 * `beforeEach`, so no case depends on run order or on what an earlier run wrote.
 *
 * `HOME` points at a fixture directory, the GitHub tokens are blanked, corepack may not
 * download, and the fixture has no projects-sync enable token, so no case reaches `~/.claude`,
 * a real ledger, or the network.
 *
 * @param {{ root: string, repoDir: string, workDir: string }} context The build tree to read
 *   settings, wiring, and scripts from, the live repository to list the build commit's tracked
 *   files from, and the directory to write under.
 * @returns {Promise<object[]>} The `BenchCase` list `scripts/bench/README.md` defines, in
 *   settings order.
 */
export async function cases({ root, repoDir, workDir }) {
  const { settings, wiring } = readBuildWiring(root);
  const hooks = wiredHooks(settings, wiring);
  const fixture = prepareFixture({ root, workDir, hooks });
  const hookCases = hooks.flatMap((hook) => casesForHook(hook, fixture));
  if (root === repoDir) return hookCases;
  return [...hookCases, ...scopeCases({ root, repoDir, workDir })];
}

function scopeConfig(arm, targetName) {
  return {
    ...CONFIG,
    fix: { ...CONFIG.fix, commands: arm.commands, passPaths: arm.passPaths },
    targets: [
      {
        name: targetName,
        prefix: 'SCOPE',
        packageName: `@bench/${targetName}`,
        pathPrefix: `packages/${targetName}/`,
        sourcePath: `packages/${targetName}/src`,
        label: 'Scope',
        verifyCommands: [],
      },
    ],
  };
}

/** The paths tracked at the build's commit, read from `repoDir`, since a cached build's own `.git` is pruned. */
function trackedPaths(root, repoDir) {
  const { commit } = JSON.parse(readFileSync(join(root, BUILD_MARKER), 'utf8'));
  const result = spawnSync(
    'git',
    ['-C', repoDir, 'ls-tree', '-r', '-z', '--name-only', commit],
    { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER },
  );
  if (result.status !== 0)
    throw new Error(
      `hooks suite: git ls-tree ${commit} failed in ${repoDir}: ${result.stderr}`,
    );
  return result.stdout.split('\0').filter(Boolean);
}

function linkEntries(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from))
    if (entry !== SKIPPED_MODULES_ENTRY)
      symlinkSync(join(from, entry), join(to, entry));
}

/** Copies each tracked file that exists in `root` into `scope`, then adds the scope scripts to its package.json. */
function copyTrackedFiles(root, scope, tracked) {
  for (const path of tracked) {
    const from = join(root, path);
    if (!lstatSync(from, { throwIfNoEntry: false })) continue;
    mkdirSync(dirname(join(scope, path)), { recursive: true });
    cpSync(from, join(scope, path), { verbatimSymlinks: true });
  }
  const rootPackage = JSON.parse(
    readFileSync(join(scope, 'package.json'), 'utf8'),
  );
  rootPackage.scripts = { ...rootPackage.scripts, ...SCOPE_PATH_SCRIPTS };
  write(join(scope, 'package.json'), json(rootPackage));
}

function linkNodeModules(root, scope, tracked) {
  if (existsSync(join(root, 'node_modules')))
    linkEntries(join(root, 'node_modules'), join(scope, 'node_modules'));
  for (const path of tracked.filter((trackedPath) =>
    trackedPath.endsWith('/package.json'),
  )) {
    const packageDir = dirname(path);
    const modules = join(root, packageDir, 'node_modules');
    if (existsSync(modules))
      symlinkSync(modules, join(scope, packageDir, 'node_modules'));
  }
}

function commitFixture(scope, env) {
  git(scope, ['config', 'user.name', 'bench'], env);
  git(scope, ['config', 'user.email', 'bench@example.invalid'], env);
  git(scope, ['add', '-A'], env);
  git(scope, ['commit', '-q', '-m', 'fixture'], env);
}

/**
 * Makes a standalone git repository at `scope` from the build commit's tracked files, copied
 * out of `root`. Its root `node_modules` is a real directory of links into the build's, and each
 * package's `node_modules` is a link, so the toolchain runs as it does here while a cache file
 * lands in the fixture. Nothing is written under `root`.
 */
function buildScopeRepo({ root, repoDir, scope, env }) {
  const tracked = trackedPaths(root, repoDir);
  copyTrackedFiles(root, scope, tracked);

  const editPath = tracked.find((path) => SCOPE_SOURCE_RE.test(path));
  if (!editPath)
    throw new Error(
      `hooks suite: no tracked packages/<name>/src/*.ts to edit in ${root}`,
    );

  git(scope, ['init', '-q', '-b', 'main'], env);
  // A package's `node_modules` is a symlink, which a `node_modules/` pattern does not match.
  write(join(scope, '.git/info/exclude'), 'node_modules\n.claude/\n');
  linkNodeModules(root, scope, tracked);
  installScripts(root, ['lint-format-fix'], join(scope, '.claude/scripts'));
  commitFixture(scope, env);
  return { editPath, targetName: SCOPE_SOURCE_RE.exec(editPath)[1] };
}

/** One scope case, which runs the build's fixer over `scope` with `arm`'s settings after a restore and a dirty edit. */
function scopeCase(
  arm,
  { scope, env, stdin, editPath, targetName, originalSource },
) {
  return {
    name: `stop-lint-format-fix-scope-${arm.name}`,
    command: '/bin/sh',
    args: ['-c', SCOPE_HOOK_COMMAND],
    cwd: scope,
    env,
    stdin,
    expectExit: [0],
    timeoutMs: SCOPE_TIMEOUT_MS,
    beforeEach: () => {
      git(scope, ['reset', '-q', '--hard', 'HEAD'], env);
      git(scope, ['clean', '-fdq'], env);
      rmSync(join(scope, '.claude/state'), { recursive: true, force: true });
      write(
        join(scope, '.claude/houserules.config.json'),
        json(scopeConfig(arm, targetName)),
      );
      writeFileSync(
        join(scope, editPath),
        `${originalSource}\n${SCOPE_EDIT_DIRTY}\n`,
      );
    },
  };
}

/**
 * Three cases that run the build's own `lint-format-fix` over a real tree, to time what
 * `fix.passPaths` changes. The tree is a standalone git repository under `workDir`, so no case
 * edits `root`, its `node_modules`, or the live repository. Each run restores the repository and
 * leaves one formatting edit in a `.ts` file under the configured target, after the transcript's
 * prompt.
 *
 * @param {{ root: string, repoDir: string, workDir: string }} context `root` must not be `repoDir`.
 */
export function scopeCases({ root, repoDir, workDir }) {
  if (root === repoDir)
    throw new Error(
      'hooks suite: scope cases need a build tree, not the live repository',
    );
  const scope = join(workDir, 'scope');
  const home = join(workDir, 'scope-home');
  const transcript = join(workDir, 'scope-transcript.jsonl');
  mkdirSync(home, { recursive: true });
  copyFileSync(join(FIXTURES, 'transcript.jsonl'), transcript);
  const env = hookCaseEnv(home, scope);
  const { editPath, targetName } = buildScopeRepo({
    root,
    repoDir,
    scope,
    env,
  });
  const originalSource = readFileSync(join(scope, editPath), 'utf8');
  const stdin = payloadFor('Stop', scope, transcript);

  return SCOPE_ARMS.map((arm) =>
    scopeCase(arm, {
      scope,
      env,
      stdin,
      editPath,
      targetName,
      originalSource,
    }),
  );
}
