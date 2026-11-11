import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { useInstalledRepo } from '#test/repo';
import { runIn } from '#test/run';
import { hookCommandsFor, settingsOf } from '#test/installed-tree';

const PLUGIN_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function rewritePackageJson(
  root: string,
  dir: string,
  mutate: (pkg: Record<string, unknown>) => void,
): void {
  const path = join(root, dir, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  mutate(pkg);
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

function installChangesets(): string {
  const root = useInstalledRepo('pnpm-monorepo', {
    modules: 'cs/changesets',
    plugins: [{ name: PLUGIN_ROOT, alias: 'cs' }],
  });
  for (const dir of ['games/cityville', 'apps/studio']) {
    rewritePackageJson(root, dir, (pkg) => {
      pkg.private = false;
    });
  }
  runIn(root, 'git', ['add', '-A']);
  runIn(root, 'git', ['commit', '-qm', 'chore: publishable packages']);
  return root;
}

function stopHookCommandFor(root: string, scriptBasename: string): string {
  const commands = hookCommandsFor(settingsOf(root), 'Stop');
  const found = commands.find((c) => c.includes(scriptBasename));
  if (!found) {
    throw new Error(`no Stop hook command wired to ${scriptBasename}`);
  }
  return found;
}

function runShellCommand(
  root: string,
  command: string,
  input: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: root,
    ...extraEnv,
  };
  delete env.NODE_PATH;
  return spawnSync('sh', ['-c', command], {
    cwd: root,
    input,
    encoding: 'utf8',
    env,
  }) as { status: number | null; stdout: string; stderr: string };
}

describe('changeset-check.mjs, Stop hook wiring', () => {
  let root: string;

  beforeEach(() => {
    root = installChangesets();
  });

  it('the settings.json Stop hook command exits 2 through the shell when the script nudges', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    const command = stopHookCommandFor(root, 'changeset-check.mjs');

    const r = runShellCommand(root, command, '{}');

    expect(r.status, `expected the shell to surface exit 2: ${r.stderr}`).toBe(
      2,
    );
    expect(r.stderr).toMatch(/--pkg @fix\/cityville/);
  });

  it('the settings.json Stop hook command exits 0 through the shell when nothing changed', () => {
    const command = stopHookCommandFor(root, 'changeset-check.mjs');

    const r = runShellCommand(root, command, '{}');

    expect(r.status, r.stderr).toBe(0);
  });

  it('dropping "exec" from the installed Stop command lets the nudge print but turns exit 2 into exit 0', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    const installedCommand = stopHookCommandFor(root, 'changeset-check.mjs');
    const withoutExec = installedCommand.replace('exec node ', 'node ');
    expect(withoutExec).not.toBe(installedCommand);

    const otherRoot = installChangesets();
    appendFileSync(
      join(otherRoot, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );

    const installed = runShellCommand(root, installedCommand, '{}');
    const dropped = runShellCommand(otherRoot, withoutExec, '{}');

    expect(installed.status, installed.stderr).toBe(2);
    expect(dropped.status, dropped.stderr).toBe(0);
    expect(dropped.stderr).toMatch(/--pkg @fix\/cityville/);
  });
});

function transcriptWith(root: string, toolNames: string[]): string {
  const path = join(root, 'transcript.jsonl');
  const records = [
    { type: 'user', message: { role: 'user', content: 'do the thing' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: toolNames.map((name, i) => ({
          type: 'tool_use',
          id: `toolu_${i}`,
          name,
          input: {},
        })),
      },
    },
  ];
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

function gitSpy(root: string): { env: Record<string, string>; log: string } {
  const dir = join(root, '.git-spy');
  const log = join(dir, 'calls.log');
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, 'git');
  writeFileSync(
    shim,
    `#!/bin/sh\necho "$@" >> "${log}"\nPATH="$REAL_PATH" exec git "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return {
    env: {
      PATH: `${dir}${delimiter}${process.env.PATH ?? tmpdir()}`,
      REAL_PATH: process.env.PATH ?? '',
    },
    log,
  };
}

describe('changeset-check.mjs, turn tool uses', () => {
  let root: string;
  let command: string;

  beforeEach(() => {
    root = installChangesets();
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    command = stopHookCommandFor(root, 'changeset-check.mjs');
  });

  it('exits 0 silently, spawning no git, when the turn used only Read', () => {
    const spy = gitSpy(root);
    const payload = JSON.stringify({
      transcript_path: transcriptWith(root, ['Read']),
    });

    const r = runShellCommand(root, command, payload, spy.env);

    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toBe('');
    expect(existsSync(spy.log)).toBe(false);
  });

  it('nudges, spawning git, when the turn used Edit', () => {
    const spy = gitSpy(root);
    const payload = JSON.stringify({
      transcript_path: transcriptWith(root, ['Read', 'Edit']),
    });

    const r = runShellCommand(root, command, payload, spy.env);

    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/--pkg @fix\/cityville/);
    expect(existsSync(spy.log)).toBe(true);
  });

  it('nudges, spawning git, when the payload has no transcript_path', () => {
    const spy = gitSpy(root);

    const r = runShellCommand(root, command, '{}', spy.env);

    expect(r.status, r.stderr).toBe(2);
    expect(existsSync(spy.log)).toBe(true);
  });
});

describe('changeset-check.mjs, packages the gate would not gate', () => {
  function commitAll(root: string, message: string): void {
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', message]);
  }

  function writeChangesetsIgnore(root: string, ignore: string[]): void {
    writeFileSync(
      join(root, '.changeset/config.json'),
      JSON.stringify({ ignore }),
    );
    commitAll(root, 'chore: changesets ignore');
  }

  function touchSource(root: string, dir: string, file: string): void {
    appendFileSync(join(root, dir, file), 'export const more = 2;\n');
  }

  function nudge(root: string): { status: number | null; stderr: string } {
    return runShellCommand(
      root,
      stopHookCommandFor(root, 'changeset-check.mjs'),
      '{}',
    );
  }

  it('still nudges for a shipped source file in a public, non-ignored package', () => {
    const root = installChangesets();
    touchSource(root, 'games/cityville', 'src/game.ts');

    const r = nudge(root);

    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/--pkg @fix\/cityville/);
  });

  it('stays silent for a scoped package the changesets ignore list names', () => {
    const root = installChangesets();
    writeChangesetsIgnore(root, ['@fix/cityville']);
    touchSource(root, 'games/cityville', 'src/game.ts');

    const r = nudge(root);

    expect(r.status, r.stderr).toBe(0);
  });

  it('stays silent for packages a scope glob in the ignore list covers', () => {
    const root = installChangesets();
    writeChangesetsIgnore(root, ['@fix/*']);
    touchSource(root, 'games/cityville', 'src/game.ts');

    const r = nudge(root);

    expect(r.status, r.stderr).toBe(0);
  });

  it('stays silent for an unscoped package the ignore list names', () => {
    const root = installChangesets();
    rewritePackageJson(root, 'games/cityville', (pkg) => {
      pkg.name = 'cityville';
    });
    writeChangesetsIgnore(root, ['cityville']);
    touchSource(root, 'games/cityville', 'src/game.ts');

    const r = nudge(root);

    expect(r.status, r.stderr).toBe(0);
  });

  it('stays silent for a private package', () => {
    const root = installChangesets();
    rewritePackageJson(root, 'apps/studio', (pkg) => {
      pkg.private = true;
    });
    commitAll(root, 'chore: studio private');
    touchSource(root, 'apps/studio', 'src/main.ts');

    const r = nudge(root);

    expect(r.status, r.stderr).toBe(0);
  });

  it('names only the public package when a private one changed beside it', () => {
    const root = installChangesets();
    rewritePackageJson(root, 'apps/studio', (pkg) => {
      pkg.private = true;
    });
    commitAll(root, 'chore: studio private');
    touchSource(root, 'apps/studio', 'src/main.ts');
    touchSource(root, 'games/cityville', 'src/game.ts');

    const r = nudge(root);

    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/--pkg @fix\/cityville/);
    expect(r.stderr).not.toMatch(/studio/);
  });

  it('stays silent for a package-root file the files list does not ship', () => {
    const root = installChangesets();
    rewritePackageJson(root, 'games/cityville', (pkg) => {
      pkg.files = ['dist'];
    });
    commitAll(root, 'chore: files list');
    writeFileSync(
      join(root, 'games/cityville/eslint.config.js'),
      'export default [];\n',
    );

    const r = nudge(root);

    expect(r.status, r.stderr).toBe(0);
  });

  it('stays silent for a path matching changesets.gateIgnore', () => {
    const root = installChangesets();
    const configPath = join(root, '.claude/houserules.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    config.changesets = {
      ...(config.changesets as Record<string, unknown>),
      gateIgnore: ['games/cityville/src/**'],
    };
    writeFileSync(configPath, JSON.stringify(config));
    commitAll(root, 'chore: gate ignore');
    touchSource(root, 'games/cityville', 'src/game.ts');

    const r = nudge(root);

    expect(r.status, r.stderr).toBe(0);
  });
});
