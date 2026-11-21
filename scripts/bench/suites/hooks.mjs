import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
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

/** Each wired hook command in `settings.hooks`, in settings order, with its event and script name. */
function wiredHooks(settings) {
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
        out.push({ event, script: match[1], command: hook.command });
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
 * One case per hook command wired in `<repoDir>/.claude/settings.json`, each run through
 * `/bin/sh -c` with the exact command string, fed the stdin payload Claude Code sends for its
 * event, against a fixture project whose `.claude/scripts/` is assembled from the build tree's
 * `packages/*\/payload-dist/scripts/`. Stop hooks get two cases, a clean tree and one with an
 * uncommitted source edit. Every case resets the fixture in `beforeEach`, so no case depends
 * on run order or on what an earlier run wrote.
 *
 * `HOME` points at a fixture directory, the GitHub tokens are blanked, corepack may not
 * download, and the fixture has no projects-sync enable token, so no case reaches `~/.claude`,
 * a real ledger, or the network.
 *
 * @param {{ root: string, repoDir: string, workDir: string }} context The build tree to read
 *   scripts from, the live repository to read settings from, and the directory to write under.
 * @returns {Promise<object[]>} The `BenchCase` list `scripts/bench/README.md` defines, in
 *   settings order.
 */
export async function cases({ root, repoDir, workDir }) {
  const settings = JSON.parse(
    readFileSync(join(repoDir, '.claude', 'settings.json'), 'utf8'),
  );
  const hooks = wiredHooks(settings);
  const fixture = prepareFixture({ root, workDir, hooks });
  return hooks.flatMap((hook) => casesForHook(hook, fixture));
}
