/**
 * The cases `payload-sync.mts` and doctor's `install-integrity.ts` must agree on. Each keeps
 * its own copy of the update-notifier skip rule and the CLI upgrade command, since a payload
 * script cannot import `src/` and `src/` cannot import `payload/`, so both suites iterate
 * these tables.
 */

interface SkipCase {
  name: string;
  env: Record<string, string>;
  skipped: boolean;
}

export const SKIP_CASES: SkipCase[] = [
  { name: 'no variables', env: {}, skipped: false },
  {
    name: 'NO_UPDATE_NOTIFIER empty',
    env: { NO_UPDATE_NOTIFIER: '' },
    skipped: true,
  },
  {
    name: 'NO_UPDATE_NOTIFIER=0',
    env: { NO_UPDATE_NOTIFIER: '0' },
    skipped: true,
  },
  { name: 'NODE_ENV=test', env: { NODE_ENV: 'test' }, skipped: true },
  {
    name: 'NODE_ENV=production',
    env: { NODE_ENV: 'production' },
    skipped: false,
  },
  { name: 'CI=1', env: { CI: '1' }, skipped: true },
  { name: 'CI=true', env: { CI: 'true' }, skipped: true },
  { name: 'CI empty', env: { CI: '' }, skipped: true },
  { name: 'CI=false', env: { CI: 'false' }, skipped: false },
  { name: 'CI=0', env: { CI: '0' }, skipped: false },
  {
    name: 'CI=0 with a CI_* variable',
    env: { CI: '0', CI_JOB_ID: '42' },
    skipped: false,
  },
  {
    name: 'CI=false with a CI_* variable',
    env: { CI: 'false', CI_JOB_ID: '42' },
    skipped: false,
  },
  {
    name: 'CONTINUOUS_INTEGRATION=1',
    env: { CONTINUOUS_INTEGRATION: '1' },
    skipped: true,
  },
  { name: 'a CI_* variable', env: { CI_PIPELINE_ID: '7' }, skipped: true },
  {
    name: 'CI=false with NO_UPDATE_NOTIFIER',
    env: { CI: 'false', NO_UPDATE_NOTIFIER: '1' },
    skipped: true,
  },
  {
    name: 'CI=false with NODE_ENV=test',
    env: { CI: 'false', NODE_ENV: 'test' },
    skipped: true,
  },
];

interface UpgradeCase {
  name: string;
  /** Repo-relative path to file content, written into an empty repo root. */
  files: Record<string, string>;
  command: string;
}

const PLAIN_PACKAGE = JSON.stringify({ name: 'host' });

function declaring(packageManager: string): string {
  return JSON.stringify({ name: 'host', packageManager });
}

const WORKSPACE_FILES = {
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'packages/a/package.json': JSON.stringify({ name: 'a' }),
};

export const UPGRADE_CASES: UpgradeCase[] = [
  {
    name: 'package-lock.json only',
    files: { 'package.json': PLAIN_PACKAGE, 'package-lock.json': '{}' },
    command: 'npm install -D @houserules/cli@latest',
  },
  {
    name: 'pnpm-lock.yaml only',
    files: { 'package.json': PLAIN_PACKAGE, 'pnpm-lock.yaml': '' },
    command: 'pnpm add -D @houserules/cli@latest',
  },
  {
    name: 'yarn.lock only',
    files: { 'package.json': PLAIN_PACKAGE, 'yarn.lock': '' },
    command: 'yarn add -D @houserules/cli@latest',
  },
  {
    name: 'bun.lock only',
    files: { 'package.json': PLAIN_PACKAGE, 'bun.lock': '' },
    command: 'bun add -D @houserules/cli@latest',
  },
  {
    name: 'bun.lockb only',
    files: { 'package.json': PLAIN_PACKAGE, 'bun.lockb': '' },
    command: 'bun add -D @houserules/cli@latest',
  },
  {
    name: 'packageManager pnpm with no lockfile',
    files: { 'package.json': declaring('pnpm@9.12.0') },
    command: 'pnpm add -D @houserules/cli@latest',
  },
  {
    name: 'packageManager yarn with no lockfile',
    files: { 'package.json': declaring('yarn@4.5.0') },
    command: 'yarn add -D @houserules/cli@latest',
  },
  {
    name: 'packageManager bun with no lockfile',
    files: { 'package.json': declaring('bun@1.1.30') },
    command: 'bun add -D @houserules/cli@latest',
  },
  {
    name: 'packageManager npm with a yarn.lock',
    files: { 'package.json': declaring('npm@10.9.0'), 'yarn.lock': '' },
    command: 'npm install -D @houserules/cli@latest',
  },
  {
    name: 'packageManager pnpm with an integrity hash and no lockfile',
    files: { 'package.json': declaring('pnpm@9.12.0+sha512.abc123') },
    command: 'pnpm add -D @houserules/cli@latest',
  },
  {
    name: 'packageManager yarn over a pnpm-lock.yaml',
    files: { 'package.json': declaring('yarn@4.5.0'), 'pnpm-lock.yaml': '' },
    command: 'yarn add -D @houserules/cli@latest',
  },
  {
    name: 'packageManager pnpm and its own pnpm-lock.yaml',
    files: { 'package.json': declaring('pnpm@9.12.0'), 'pnpm-lock.yaml': '' },
    command: 'pnpm add -D @houserules/cli@latest',
  },
  {
    name: 'a packageManager value with no version',
    files: { 'package.json': declaring('pnpm'), 'yarn.lock': '' },
    command: 'yarn add -D @houserules/cli@latest',
  },
  {
    name: 'a package.json with neither field nor lockfile',
    files: { 'package.json': PLAIN_PACKAGE },
    command: 'npm install -D @houserules/cli@latest',
  },
  {
    name: 'no package.json and no lockfile',
    files: {},
    command: 'npm install -D @houserules/cli@latest',
  },
  {
    name: 'a pnpm workspace root by lockfile',
    files: {
      'package.json': PLAIN_PACKAGE,
      'pnpm-lock.yaml': '',
      ...WORKSPACE_FILES,
    },
    command: 'pnpm add -D -w @houserules/cli@latest',
  },
  {
    name: 'a pnpm workspace root by packageManager with no lockfile',
    files: { 'package.json': declaring('pnpm@9.12.0'), ...WORKSPACE_FILES },
    command: 'pnpm add -D -w @houserules/cli@latest',
  },
  {
    name: 'a yarn workspace root',
    files: {
      'package.json': JSON.stringify({
        name: 'host',
        packageManager: 'yarn@4.5.0',
        workspaces: ['packages/*'],
      }),
      'packages/a/package.json': JSON.stringify({ name: 'a' }),
    },
    command: 'yarn add -D @houserules/cli@latest',
  },
];
