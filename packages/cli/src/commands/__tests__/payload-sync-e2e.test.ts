import { describe, expect, it, onTestFinished } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HOOK_RUNS_LOG_PATH,
  HOOK_RUNS_ROTATED_PATH,
} from '../../hook-runs-log.js';
import { useInstalledRepo } from '#test/repo';
import { runIn } from '#test/run';
import {
  dispatchedScriptsFor,
  editHouseConfig,
  hookCommandsFor,
  manifestOf,
  readJson,
  settingsOf,
  writeManifest,
} from '#test/installed-tree';

const CLI_JS = fileURLToPath(new URL('../../../dist/cli.js', import.meta.url));
const CLI_BIN = fileURLToPath(
  new URL('../../../bin/houserules.mjs', import.meta.url),
);
const CLI_PACKAGE = readJson<{ name: string; version: string }>(
  fileURLToPath(new URL('../../../package.json', import.meta.url)),
);
const CLI_VERSION = CLI_PACKAGE.version;
const OLDER_VERSION = '0.0.1';
const MANIFEST = '.claude/houserules.manifest.json';
const SYNC_SCRIPT = '.claude/scripts/payload-sync.mjs';
const IMPORT_TARGET = '.claude/houserules.md';
const EDITED_RULE = '.claude/rules/code-cleanliness.md';
const LOCAL_EDIT = '\nA line this repo added by hand.\n';
const SYNCED_LINE = new RegExp(
  `^\\[houserules\\] synced to ${CLI_VERSION.replace(/\./g, '\\.')}: \\d+ written, 1 kept \\(edited\\), run houserules doctor$`,
);
const FRESH_SYNCED_LINE = new RegExp(
  `^\\[houserules\\] synced to ${CLI_VERSION.replace(/\./g, '\\.')}: [1-9]\\d* written, 0 kept \\(edited\\)$`,
);
const RESTART_LINE =
  '[houserules] Restart the session so the synced skills, rules, and agents load.';
const KIT_LINE = `[houserules] kit ${CLI_VERSION}`;

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

const RUNS_BUILT_CLI = `#!/bin/sh\nexec node "${CLI_JS}" "$@"\n`;
const EXITS_NON_ZERO = '#!/bin/sh\necho "cli crashed" >&2\nexit 3\n';

function installedFixture(): string {
  const root = useInstalledRepo('npm-single', {
    modules: 'code-cleanliness,-session-context',
  });
  const { modules } = manifestOf(root);
  editHouseConfig(root, (config) => {
    config.modules = modules;
  });
  expect(
    dispatchedScriptsFor(root, 'SessionStart'),
    'payload-sync is dispatched on SessionStart',
  ).toContain('payload-sync.mjs');
  return root;
}

function installLocalCli(root: string, binary = RUNS_BUILT_CLI): void {
  const pkgDir = join(root, 'node_modules/@houserules/cli');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: CLI_PACKAGE.name, version: CLI_VERSION }),
  );
  writeExecutable(join(root, 'node_modules/.bin/houserules'), binary);
}

function installGlobalCli(): string {
  const globalBin = scratchDir('hr-global-bin-');
  symlinkSync(CLI_BIN, join(globalBin, 'houserules'));
  return globalBin;
}

function nodeOnlyBin(): string {
  const dir = scratchDir('hr-node-bin-');
  symlinkSync(process.execPath, join(dir, 'node'));
  return dir;
}

function syncHookCommand(root: string): string {
  const command = hookCommandsFor(settingsOf(root), 'SessionStart').find(
    (c) => c.includes('hook-dispatch.mjs') && c.includes('update --sync'),
  );
  if (!command)
    throw new Error(
      'no SessionStart dispatcher entry carries the bootstrap fallback',
    );
  return command;
}

function runSyncHook(root: string, extraPathDirs: string[] = []) {
  const result = spawnSync('/bin/sh', ['-c', syncHookCommand(root)], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'SessionStart' }),
    env: {
      PATH: [...extraPathDirs, nodeOnlyBin(), '/bin', '/usr/bin'].join(':'),
      HOME: scratchDir('hr-home-'),
      CLAUDE_PROJECT_DIR: root,
      NO_UPDATE_NOTIFIER: '1',
    },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    lines: result.stdout.split('\n').filter(Boolean),
  };
}

const DISPATCHER_RUN_LOGS = new Set([
  HOOK_RUNS_LOG_PATH,
  HOOK_RUNS_ROTATED_PATH,
]);

/** Every file under `root` as base64, leaving out git, dependencies, and the dispatcher's own run log. */
function readTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (dir === root && (name === '.git' || name === 'node_modules'))
        continue;
      const full = join(dir, name);
      const path = relative(root, full);
      if (statSync(full).isDirectory()) walk(full);
      else if (!DISPATCHER_RUN_LOGS.has(path))
        out[path] = readFileSync(full).toString('base64');
    }
  };
  walk(root);
  return out;
}

function ageManifest(root: string): void {
  writeManifest(root, { ...manifestOf(root), kitVersion: OLDER_VERSION });
}

function editIgnoredFile(root: string): Buffer {
  writeFileSync(
    join(root, EDITED_RULE),
    readFileSync(join(root, EDITED_RULE), 'utf8') + LOCAL_EDIT,
  );
  expect(runIn(root, 'git', ['check-ignore', EDITED_RULE]).trim()).toBe(
    EDITED_RULE,
  );
  return readFileSync(join(root, EDITED_RULE));
}

function freshClone(root: string): void {
  runIn(root, 'git', ['add', '-A']);
  runIn(root, 'git', ['clean', '-fdX', '-q']);
}

function missingDests(root: string): string[] {
  return Object.keys(manifestOf(root).files).filter(
    (dest) => !existsSync(join(root, dest)),
  );
}

describe('payload-sync SessionStart hook on a fresh clone with a local CLI', () => {
  it('runs the bootstrap fallback and ends with every recorded file on disk', () => {
    const root = installedFixture();
    const recordedDests = Object.keys(manifestOf(root).files).sort();
    freshClone(root);
    installLocalCli(root);
    expect(existsSync(join(root, SYNC_SCRIPT))).toBe(false);
    expect(existsSync(join(root, MANIFEST))).toBe(false);

    const result = runSyncHook(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0]).toMatch(FRESH_SYNCED_LINE);
    expect(result.lines[1]).toBe(RESTART_LINE);
    expect(Object.keys(manifestOf(root).files).sort()).toEqual(recordedDests);
    expect(missingDests(root)).toEqual([]);
  });
});

describe('payload-sync SessionStart hook when the import target is missing', () => {
  it('restores .claude/houserules.md at the current kit version and prints the restart line once', () => {
    const root = installedFixture();
    installLocalCli(root);
    const original = readFileSync(join(root, IMPORT_TARGET), 'utf8');
    rmSync(join(root, IMPORT_TARGET));
    expect(manifestOf(root).kitVersion).toBe(CLI_VERSION);

    const result = runSyncHook(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0]).toMatch(FRESH_SYNCED_LINE);
    expect(result.lines[1]).toBe(RESTART_LINE);
    expect(result.lines[2]).toBe(KIT_LINE);
    expect(readFileSync(join(root, IMPORT_TARGET), 'utf8')).toBe(original);
    expect(original).toContain('### houserules sections');
  });

  it('syncs nothing and prints no restart line when the target is present and the version matches', () => {
    const root = installedFixture();
    installLocalCli(root);
    const before = readTree(root);

    const result = runSyncHook(root);

    expect(result.status, result.stderr).toBe(0);
    expect(result.lines).toEqual([KIT_LINE]);
    expect(readTree(root)).toEqual(before);
  });
});

describe('payload-sync SessionStart hook on an install older than the local CLI', () => {
  it('refreshes the install, keeps the local edit, and prints only the kit line on the next run', () => {
    const root = installedFixture();
    installLocalCli(root);
    ageManifest(root);
    const edited = editIgnoredFile(root);

    const first = runSyncHook(root);

    expect(first.status, first.stderr).toBe(0);
    expect(first.lines).toHaveLength(3);
    expect(first.lines[0]).toMatch(SYNCED_LINE);
    expect(first.lines[1]).toBe(RESTART_LINE);
    expect(first.lines[2]).toBe(KIT_LINE);
    expect(readFileSync(join(root, EDITED_RULE))).toEqual(edited);
    expect(manifestOf(root).kitVersion).toBe(CLI_VERSION);
    expect(missingDests(root)).toEqual([]);

    const synced = readTree(root);
    const second = runSyncHook(root);

    expect(second.status, second.stderr).toBe(0);
    expect(second.lines).toEqual([KIT_LINE]);
    expect(readTree(root)).toEqual(synced);
  });
});

describe('payload-sync SessionStart hook with only a global CLI on PATH', () => {
  it('syncs an older install to the global CLI version and keeps the local edit', () => {
    const root = installedFixture();
    const globalBin = installGlobalCli();
    ageManifest(root);
    const edited = editIgnoredFile(root);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);

    const result = runSyncHook(root, [globalBin]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.lines[0]).toMatch(SYNCED_LINE);
    expect(result.lines[1]).toBe(RESTART_LINE);
    expect(result.lines[2]).toBe(KIT_LINE);
    expect(readFileSync(join(root, EDITED_RULE))).toEqual(edited);
    expect(manifestOf(root).kitVersion).toBe(CLI_VERSION);
    expect(missingDests(root)).toEqual([]);
  });

  it('prints only the kit line and changes no byte on a current install', () => {
    const root = installedFixture();
    const globalBin = installGlobalCli();
    const before = readTree(root);

    const result = runSyncHook(root, [globalBin]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.lines).toEqual([KIT_LINE]);
    expect(readTree(root)).toEqual(before);
  });
});

describe('payload-sync SessionStart hook when the CLI exits non-zero', () => {
  it('exits 0 when the script runs the failing binary', () => {
    const root = installedFixture();
    installLocalCli(root, EXITS_NON_ZERO);
    ageManifest(root);

    const result = runSyncHook(root);

    expect(result.status, result.stderr).toBe(0);
  });

  it('exits 0 when the bootstrap fallback runs the failing binary', () => {
    const root = installedFixture();
    freshClone(root);
    installLocalCli(root, EXITS_NON_ZERO);
    expect(existsSync(join(root, SYNC_SCRIPT))).toBe(false);

    const result = runSyncHook(root);

    expect(result.status, result.stderr).toBe(0);
  });
});
