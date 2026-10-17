#!/usr/bin/env node
/**
 * The initializer behind `npm create @houserules`, `pnpm create @houserules`, and
 * `yarn create @houserules`, run inside the repo to set up. It adds `@houserules/cli` to the
 * repo's devDependencies with the package manager that invoked it, at the cli version this
 * package was published with, then runs `houserules init` from the repo's own copy. Every
 * argument is handed to `init`, so `--yes` and `--dry-run` work, and the install happens
 * either way. The exit code is the package manager's when the install fails, and init's
 * otherwise.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import pinnedCli from '@houserules/cli/package.json' with { type: 'json' };

const CLI = '@houserules/cli';

const INSTALL_ARGS = {
  pnpm: ['add', '-D'],
  yarn: ['add', '-D'],
  bun: ['add', '-d'],
  npm: ['install', '--save-dev'],
};

/** The package manager that ran `create`, else the one whose lockfile the repo has, else npm. */
function packageManager(root) {
  const agent = process.env.npm_config_user_agent ?? '';
  const invoker = Object.keys(INSTALL_ARGS).find((name) =>
    agent.startsWith(`${name}/`),
  );
  if (invoker) return invoker;
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb')))
    return 'bun';
  return 'npm';
}

function run(command, args, cwd) {
  return spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
}

const root = process.cwd();
if (!existsSync(join(root, 'package.json'))) {
  console.error(
    `@houserules/create: no package.json in ${root}. Run \`npm init -y\` first, then run this again.`,
  );
  process.exit(1);
}

const manager = packageManager(root);
const install = run(
  manager,
  [...INSTALL_ARGS[manager], `${CLI}@^${pinnedCli.version}`],
  root,
);
if (install.status !== 0) process.exit(install.status ?? 1);

const repoRequire = createRequire(join(root, 'package.json'));
const installedManifest = repoRequire.resolve(`${CLI}/package.json`);
const cliBin = join(
  dirname(installedManifest),
  repoRequire(installedManifest).bin.houserules,
);
const init = run(
  process.execPath,
  [cliBin, 'init', ...process.argv.slice(2)],
  root,
);
process.exit(init.status ?? 1);
