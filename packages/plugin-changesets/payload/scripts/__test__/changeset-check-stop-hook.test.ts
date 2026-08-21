import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
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
): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_PROJECT_DIR: root,
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

  it('a plain "node" wrapper, unlike the installed "exec node" one, swallows the exit-2 signal into the missing-script fallback', () => {
    appendFileSync(
      join(root, 'games/cityville/src/game.ts'),
      'export const more = 2;\n',
    );
    const installedCommand = stopHookCommandFor(root, 'changeset-check.mjs');
    const withoutExec = installedCommand.replace('exec node ', 'node ');
    expect(withoutExec).not.toBe(installedCommand);

    const r = runShellCommand(root, withoutExec, '{}');

    expect(
      r.status,
      `dropping exec should fall through to the "|| { ... exit 1 }" branch: ${r.stderr}`,
    ).toBe(1);
    expect(r.stderr).toMatch(/changeset-check\.mjs missing/);
  });
});
