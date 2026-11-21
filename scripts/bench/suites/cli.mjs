import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sandboxEnv } from './sandbox-env.mjs';

const TRANSCRIPTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'cli',
  'transcripts',
);

const CLI_ENTRY = ['packages', 'cli', 'dist', 'cli.js'];
const NON_ALPHANUMERIC = /[^A-Za-z0-9]/g;
const GIT_QUIET_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'commit.gpgsign=false',
];
const GIT_CLEAN_FLAGS = '-fdxq';
const EXPECT_EXIT_SUCCESS = [0];

const FIXTURE_PACKAGE = {
  name: 'bench-fixture',
  version: '0.0.0',
  private: true,
  scripts: { check: 'node -e 0', test: 'node -e 0' },
};

function git(cwd, args) {
  const result = spawnSync('git', [...GIT_QUIET_CONFIG, ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`);
}

/** Makes `dir` a git repo with a `package.json` and one commit, the shape `init` expects. */
function createRepo(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(FIXTURE_PACKAGE, null, 2)}\n`,
  );
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'bench']);
  git(dir, ['config', 'user.email', 'bench@example.invalid']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return realpathSync(dir);
}

/** Puts the repo back at its commit with nothing untracked or ignored, so `init` is a first install. */
function resetRepo(dir) {
  git(dir, ['reset', '-q', '--hard', 'HEAD']);
  git(dir, ['clean', GIT_CLEAN_FLAGS]);
}

function runCli({ root, env, args, cwd }) {
  const result = spawnSync(
    process.execPath,
    [join(root, ...CLI_ENTRY), ...args],
    { cwd, env: { ...process.env, ...env }, encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(
      `cli ${args.join(' ')} exited ${result.status} in ${cwd}: ${result.stdout}${result.stderr}`,
    );
}

/** The directory name Claude Code gives a project's transcripts: every non-alphanumeric becomes `-`. */
function transcriptSlug(projectDir) {
  return projectDir.replace(NON_ALPHANUMERIC, '-');
}

/** Copies the fixed transcript set to where `report` looks for `projectDir` under `claudeDir`. */
function installTranscripts(claudeDir, projectDir) {
  cpSync(TRANSCRIPTS, join(claudeDir, 'projects', transcriptSlug(projectDir)), {
    recursive: true,
  });
}

/** Builds the sandboxed env and the three fixture repos the cases run in; `installedDir` is already installed. */
function prepareFixtures(root, workDir) {
  const home = join(workDir, 'home');
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const env = { ...sandboxEnv(home), CLAUDE_CONFIG_DIR: claudeDir };

  const initDir = createRepo(join(workDir, 'init-project'));
  const installedDir = createRepo(join(workDir, 'installed-project'));
  runCli({
    root,
    env,
    args: ['init', '--yes', installedDir],
    cwd: installedDir,
  });
  const reportDir = createRepo(join(workDir, 'report-project'));
  installTranscripts(claudeDir, reportDir);
  return { env, initDir, installedDir, reportDir };
}

/**
 * Four cases that run the built CLI, `<root>/packages/cli/dist/cli.js`, against fixture
 * repos under `workDir`:
 *
 * - `init`: `init --yes` on an un-initialized repo, restored to its commit with `git clean`
 *   before every run, so each run is a first install.
 * - `update-noop`: `update` on a repo `init` already installed, where nothing is left to refresh.
 * - `doctor`: `doctor` on an installed repo.
 * - `report`: `report` over the fixed transcript set in `fixtures/cli/transcripts/`, which
 *   holds two sessions and one subagent transcript, copied to the slug directory under the
 *   fixture's `CLAUDE_CONFIG_DIR`.
 *
 * Every case runs under `sandboxEnv`, with `HOME` and `CLAUDE_CONFIG_DIR` pointing into
 * `workDir`, so none reaches the real `~/.claude`, a GitHub token, or the network.
 *
 * @param {{ root: string, repoDir: string, workDir: string }} context The build tree to run the
 *   CLI from, the live repository (unused), and the directory to write fixtures under.
 * @returns {Promise<object[]>} The `BenchCase` list `scripts/bench/README.md` defines.
 */
export async function cases({ root, workDir }) {
  const { env, initDir, installedDir, reportDir } = prepareFixtures(
    root,
    workDir,
  );

  const caseFor = ({
    name,
    args,
    cwd,
    expectExit = EXPECT_EXIT_SUCCESS,
    beforeEach,
  }) => ({
    name,
    command: process.execPath,
    args: [join(root, ...CLI_ENTRY), ...args],
    cwd,
    env,
    expectExit,
    beforeEach,
  });

  return [
    caseFor({
      name: 'init',
      args: ['init', '--yes', initDir],
      cwd: initDir,
      beforeEach: () => resetRepo(initDir),
    }),
    caseFor({
      name: 'update-noop',
      args: ['update', installedDir],
      cwd: installedDir,
    }),
    caseFor({
      name: 'doctor',
      args: ['doctor', installedDir],
      cwd: installedDir,
    }),
    caseFor({ name: 'report', args: ['report', reportDir], cwd: reportDir }),
  ];
}
