import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { useInstalledRepo } from '#test/repo';
import { hookCommandsFor, settingsOf } from '#test/installed-tree';

const PLUGIN_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function installChangesets(): string {
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'cs/changesets',
    plugins: [{ name: PLUGIN_ROOT, alias: 'cs' }],
  });
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
