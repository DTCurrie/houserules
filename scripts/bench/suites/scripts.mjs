import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sandboxEnv } from './sandbox-env.mjs';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'scripts',
);

const PLAN_SLUG = 'widget-service';
const PROSE_FIXTURE = 'guide.md';
const CHANGESET_SUMMARY = 'Add the widget read routes to the service.';
const NO_OP_SCRIPT = 'node -e 0';
const GIT_QUIET_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'commit.gpgsign=false',
];
const EXPECT_EXIT_FINDINGS = [1];

const SCRIPT_NAMES = [
  'plan-lint',
  'closeout',
  'verify-changed',
  'prose-lint',
  'changeset-write',
];

const PROJECT_CONFIG = {
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
  targets: [],
};

const VERIFY_PACKAGES = ['alpha', 'beta'];
const CHANGED_SOURCE = 'packages/alpha/src/index.mjs';
const CLEAN_SOURCE = 'export const value = 1;\n';
const DIRTY_SOURCE = 'export const value = 2;\n';

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function git(cwd, args, env) {
  const result = spawnSync('git', [...GIT_QUIET_CONFIG, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
}

function payloadScriptDirs(root) {
  const packages = join(root, 'packages');
  return readdirSync(packages)
    .map((name) => join(packages, name, 'payload-dist', 'scripts'))
    .filter((dir) => existsSync(dir));
}

/**
 * Lays the five scripts out the way an install does: each at `.claude/scripts/<name>.mjs`
 * and every payload lib flat under `.claude/scripts/lib/`.
 */
function installScripts(root, dest) {
  const dirs = payloadScriptDirs(root);
  mkdirSync(join(dest, 'lib'), { recursive: true });
  for (const dir of dirs) {
    const lib = join(dir, 'lib');
    if (!existsSync(lib)) continue;
    for (const file of readdirSync(lib))
      if (file.endsWith('.mjs'))
        copyFileSync(join(lib, file), join(dest, 'lib', file));
  }
  for (const script of SCRIPT_NAMES) {
    const found = dirs
      .map((dir) => join(dir, `${script}.mjs`))
      .filter((path) => existsSync(path));
    if (found.length !== 1)
      throw new Error(
        `scripts suite: expected one built ${script}.mjs under ${root}/packages/*/payload-dist/scripts, found ${found.length}`,
      );
    copyFileSync(found[0], join(dest, `${script}.mjs`));
  }
}

function commitFixture(project, env) {
  git(project, ['init', '-q', '-b', 'main'], env);
  git(project, ['config', 'user.name', 'bench'], env);
  git(project, ['config', 'user.email', 'bench@example.invalid'], env);
  git(project, ['add', '-A'], env);
  git(project, ['commit', '-q', '-m', 'fixture'], env);
}

/**
 * The widget project: a single-package repo holding the plan workspace, the prose file, and an
 * empty `.changeset/`. `@changesets/cli` is linked in from the build tree so `changeset-write`
 * resolves its writer without a network install.
 */
function buildProject({ root, project, env }) {
  write(
    join(project, 'package.json'),
    json({ name: '@bench/widget', version: '0.0.0', type: 'module' }),
  );
  write(join(project, '.gitignore'), 'node_modules/\n.claude/state/\n');
  write(
    join(project, '.changeset/config.json'),
    json({ baseBranch: 'main', ignore: [] }),
  );
  write(join(project, '.claude/houserules.config.json'), json(PROJECT_CONFIG));
  cpSync(join(FIXTURES, 'plan'), join(project, '.claude', 'plans', PLAN_SLUG), {
    recursive: true,
  });
  copyFileSync(
    join(FIXTURES, 'prose', PROSE_FIXTURE),
    join(project, PROSE_FIXTURE),
  );
  installScripts(root, join(project, '.claude/scripts'));
  mkdirSync(join(project, 'node_modules', '@changesets'), { recursive: true });
  symlinkSync(
    realpathSync(join(root, 'node_modules', '@changesets', 'cli')),
    join(project, 'node_modules', '@changesets', 'cli'),
  );
  commitFixture(project, env);
}

/**
 * The verify project: a pnpm workspace of two packages whose `check` and `test` scripts do
 * nothing, with `alpha` edited against HEAD after each reset.
 */
function buildVerifyProject({ root, project, env }) {
  write(
    join(project, 'package.json'),
    json({ name: 'verify-fixture', private: true }),
  );
  write(join(project, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  write(join(project, '.gitignore'), 'node_modules/\n');
  for (const name of VERIFY_PACKAGES) {
    write(
      join(project, 'packages', name, 'package.json'),
      json({
        name: `@bench/${name}`,
        version: '0.0.0',
        type: 'module',
        scripts: { check: NO_OP_SCRIPT, test: NO_OP_SCRIPT },
      }),
    );
    write(join(project, 'packages', name, 'src/index.mjs'), CLEAN_SOURCE);
  }
  const targets = VERIFY_PACKAGES.map((name) => ({
    name,
    prefix: name.toUpperCase(),
    packageName: `@bench/${name}`,
    pathPrefix: `packages/${name}/`,
    sourcePath: `packages/${name}/src`,
    label: name,
    verifyCommands: ['check', 'test'],
  }));
  write(
    join(project, '.claude/houserules.config.json'),
    json({ ...PROJECT_CONFIG, targets }),
  );
  installScripts(root, join(project, '.claude/scripts'));
  commitFixture(project, env);
}

function resetVerifyProject(project, env) {
  git(project, ['reset', '-q', '--hard', 'HEAD'], env);
  git(project, ['clean', '-fdq'], env);
  writeFileSync(join(project, CHANGED_SOURCE), DIRTY_SOURCE);
}

function resetChangesets(project) {
  const dir = join(project, '.changeset');
  for (const file of readdirSync(dir))
    if (file.endsWith('.md')) rmSync(join(dir, file));
  rmSync(join(project, '.claude/state'), { recursive: true, force: true });
}

/** Builds a `BenchCase` that runs `.claude/scripts/<script>.mjs` under `env`. */
function scriptCaseIn(env) {
  return ({ cwd, name, script, args = [], ...extra }) => ({
    name,
    command: process.execPath,
    args: [join('.claude', 'scripts', `${script}.mjs`), ...args],
    cwd,
    env,
    ...extra,
  });
}

/**
 * Five cases over the payload scripts a skill calls, each run as `node .claude/scripts/<name>.mjs`
 * from a fixture project, the way its skill does. `plan-lint`, `prose-lint`, `closeout`, and
 * `changeset-write` share one single-package project holding a small plan workspace and a
 * 350-line markdown file with findings. `verify-changed --run` gets its own pnpm workspace of
 * two packages with no-op `check` and `test` scripts, one edited against HEAD, so it measures
 * the script plus the trivial commands it spawns. `changeset-write` empties `.changeset/` in
 * `beforeEach`, and `verify-changed` resets its tree there.
 *
 * `HOME` points at a fixture directory and pnpm and corepack are held offline, so no case
 * reaches `~/.claude`, a real ledger, the live `.changeset/`, or the network.
 *
 * @param {{ root: string, repoDir: string, workDir: string }} context The build tree to read
 *   scripts and `@changesets/cli` from, the live repository (unused here), and the directory
 *   to write under.
 * @returns {Promise<object[]>} The `BenchCase` list `scripts/bench/README.md` defines.
 */
export async function cases({ root, workDir }) {
  const home = join(workDir, 'home');
  mkdirSync(home, { recursive: true });
  const env = sandboxEnv(home);
  const project = join(workDir, 'widget');
  const verifyProject = join(workDir, 'verify');
  buildProject({ root, project, env });
  buildVerifyProject({ root, project: verifyProject, env });

  const caseIn = scriptCaseIn(env);

  return [
    caseIn({
      cwd: project,
      name: 'plan-lint',
      script: 'plan-lint',
      expectExit: EXPECT_EXIT_FINDINGS,
    }),
    caseIn({
      cwd: project,
      name: 'prose-lint',
      script: 'prose-lint',
      args: [PROSE_FIXTURE],
      expectExit: EXPECT_EXIT_FINDINGS,
    }),
    caseIn({
      cwd: project,
      name: 'closeout',
      script: 'closeout',
      args: ['checklist', join('.claude', 'plans', PLAN_SLUG)],
    }),
    caseIn({
      cwd: verifyProject,
      name: 'verify-changed',
      script: 'verify-changed',
      args: ['--run'],
      beforeEach: () => resetVerifyProject(verifyProject, env),
    }),
    caseIn({
      cwd: project,
      name: 'changeset-write',
      script: 'changeset-write',
      args: ['--pkg', '@bench/widget:minor', '--summary', CHANGESET_SUMMARY],
      beforeEach: () => resetChangesets(project),
    }),
  ];
}
