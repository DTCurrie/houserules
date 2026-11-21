import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hookCommand,
  hookFragment,
  isGuardedHookCommand,
} from '../hook-wiring.js';
import { mergeSettings } from '../merge-settings.js';

describe('hookFragment', () => {
  it('carries only type, command, and statusMessage when no options are given', () => {
    const fragment = hookFragment('PreToolUse', 'Bash', 'guard-bash.mjs');
    const hook = fragment.hooks!.PreToolUse![0]!.hooks[0]!;
    expect(hook).toEqual({
      type: 'command',
      command: hookCommand('guard-bash.mjs'),
    });
  });

  it('lands if, timeout, and async on the emitted hook entry when set', () => {
    const fragment = hookFragment(
      'PreToolUse',
      'Bash',
      'guard-bash.mjs',
      undefined,
      { if: '${CLAUDE_TOOL_NAME} == "Bash"', timeout: 30, async: true },
    );
    const hook = fragment.hooks!.PreToolUse![0]!.hooks[0]!;
    expect(hook.if).toBe('${CLAUDE_TOOL_NAME} == "Bash"');
    expect(hook.timeout).toBe(30);
    expect(hook.async, 'hook.async is set to true').toBe(true);
  });

  it('omits if, timeout, and async when unset', () => {
    const fragment = hookFragment('PreToolUse', 'Bash', 'guard-bash.mjs');
    const hook = fragment.hooks!.PreToolUse![0]!.hooks[0]!;
    expect('if' in hook, 'hook has no if key').toBe(false);
    expect('timeout' in hook, 'hook has no timeout key').toBe(false);
    expect('async' in hook, 'hook has no async key').toBe(false);
  });

  it('lands onFailure block on the emitted hook entry when set', () => {
    const fragment = hookFragment(
      'PreToolUse',
      'Bash',
      'guard-bash.mjs',
      undefined,
      { onFailure: 'block' },
    );
    const hook = fragment.hooks!.PreToolUse![0]!.hooks[0]!;
    expect(hook.onFailure).toBe('block');
  });

  it('omits onFailure when unset', () => {
    const fragment = hookFragment('PreToolUse', 'Bash', 'guard-bash.mjs');
    const hook = fragment.hooks!.PreToolUse![0]!.hooks[0]!;
    expect('onFailure' in hook, 'hook has no onFailure key').toBe(false);
  });

  it('round-trips if, timeout, and async through mergeSettings', () => {
    const fragment = hookFragment(
      'PreToolUse',
      'Bash',
      'guard-bash.mjs',
      undefined,
      { if: 'always', timeout: 12, async: false },
    );
    const { merged } = mergeSettings(null, fragment);
    const hook = merged.hooks!.PreToolUse![0]!.hooks[0]!;
    expect(hook.if).toBe('always');
    expect(hook.timeout).toBe(12);
    expect(hook.async, 'hook.async is set to false').toBe(false);
  });
});

describe('hookFragment fallback by event', () => {
  function commandFor(event: string): string {
    return hookFragment(event, null, 'x.mjs').hooks![event]![0]!.hooks[0]!
      .command;
  }

  it('writes the stderr notice and exit 1 for PreToolUse', () => {
    expect(commandFor('PreToolUse')).toMatch(
      / \|\| \{ echo "\[houserules\] x\.mjs: this install's generated files are not synced yet\. Run your dependency install \(npm install, pnpm install, or yarn\), or houserules update for a global CLI\. This call is blocked until then\." >&2; exit 1; \}$/,
    );
  });

  it('blocks with the notice on stderr when the script is absent in a real shell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hookwiring-'));
    try {
      const result = spawnSync('sh', ['-c', hookCommand('x.mjs', 'guard')], {
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(
        "[houserules] x.mjs: this install's generated files are not synced yet. Run your dependency install (npm install, pnpm install, or yarn), or houserules update for a global CLI. This call is blocked until then.\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the stdout notice then exit 0 for SessionStart', () => {
    const command = commandFor('SessionStart');
    expect(command).toMatch(
      / \|\| \{ echo "\[houserules\] x\.mjs: this install's generated files are not synced yet\. Run your dependency install \(npm install, pnpm install, or yarn\), or houserules update for a global CLI\."; exit 0; \}$/,
    );
    expect(command).not.toContain('>&2');
  });

  it('writes a silent exit 0 for Stop', () => {
    expect(commandFor('Stop')).toMatch(/ \|\| exit 0$/);
  });
});

describe('isGuardedHookCommand', () => {
  it.each(['guard', 'hint', 'silent', 'bootstrap'] as const)(
    'is true for the %s form',
    (fallback) => {
      expect(isGuardedHookCommand(hookCommand('x.mjs', fallback))).toBe(true);
    },
  );

  it('is false for a bare node invocation', () => {
    expect(isGuardedHookCommand('node .claude/scripts/x.mjs')).toBe(false);
  });
});

describe('hookCommand bootstrap fallback in a real shell', () => {
  const SYNCED_LINE =
    '[houserules] synced to 9.9.9: 3 written, 0 kept (edited)';
  const SYNCED_NOTICE = `${SYNCED_LINE}\n[houserules] Restart the session so the synced skills, rules, and agents load.\n`;
  const INSTALL_NOTICE =
    '[houserules] x.mjs is not synced yet. Run your dependency install (npm install, pnpm install, or yarn) to sync this install.\n';
  let project: string;
  let toolDir: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'bootstrap-project-'));
    toolDir = mkdtempSync(join(tmpdir(), 'bootstrap-tools-'));
    symlinkSync(process.execPath, join(toolDir, 'node'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(toolDir, { recursive: true, force: true });
  });

  function writeStub(
    path: string,
    exitCode: number,
    output: string = SYNCED_LINE,
  ): string {
    const argvFile = join(project, `argv-${exitCode}.txt`);
    mkdirSync(join(path, '..'), { recursive: true });
    const echo = output ? `echo '${output}'\n` : '';
    writeFileSync(
      path,
      `#!/bin/sh\necho "$@" > "${argvFile}"\n${echo}exit ${exitCode}\n`,
    );
    chmodSync(path, 0o755);
    return argvFile;
  }

  function runBootstrap() {
    return spawnSync('sh', ['-c', hookCommand('x.mjs', 'bootstrap')], {
      env: {
        PATH: `${toolDir}:/bin:/usr/bin`,
        CLAUDE_PROJECT_DIR: project,
      },
      encoding: 'utf8',
    });
  }

  it('runs the script and passes its exit code through when it is present', () => {
    const scriptDir = join(project, '.claude', 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      join(scriptDir, 'x.mjs'),
      'console.log("ran"); process.exit(2);\n',
    );

    const result = runBootstrap();

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('ran\n');
  });

  it('syncs through the project-local binary when the script is absent', () => {
    const argvFile = writeStub(
      join(project, 'node_modules', '.bin', 'houserules'),
      0,
    );

    const result = runBootstrap();

    expect(result.status).toBe(0);
    expect(readFileSync(argvFile, 'utf8')).toBe(`update --sync ${project}\n`);
    expect(result.stdout).toBe(SYNCED_NOTICE);
  });

  it('syncs through a PATH binary when there is no local one', () => {
    const argvFile = writeStub(join(toolDir, 'houserules'), 0);

    const result = runBootstrap();

    expect(result.status).toBe(0);
    expect(readFileSync(argvFile, 'utf8')).toBe(`update --sync ${project}\n`);
    expect(result.stdout).toBe(SYNCED_NOTICE);
  });

  it('passes a failure line through without the restart line', () => {
    const failure = '[houserules] sync failed: settings.json is not valid JSON';
    writeStub(join(project, 'node_modules', '.bin', 'houserules'), 0, failure);

    const result = runBootstrap();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${failure}\n`);
  });

  it('prints nothing when the sync wrote nothing', () => {
    writeStub(join(project, 'node_modules', '.bin', 'houserules'), 0, '');

    const result = runBootstrap();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 0 when the sync binary exits 1', () => {
    writeStub(join(project, 'node_modules', '.bin', 'houserules'), 1);

    const result = runBootstrap();

    expect(result.status).toBe(0);
  });

  it('prints the install hint and exits 0 when no binary exists', () => {
    const result = runBootstrap();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(INSTALL_NOTICE);
  });

  it('never mentions npx in any output', () => {
    writeStub(join(project, 'node_modules', '.bin', 'houserules'), 1);
    const withBinary = runBootstrap();
    rmSync(join(project, 'node_modules'), { recursive: true });
    const withoutBinary = runBootstrap();

    const output = [withBinary, withoutBinary]
      .map((result) => result.stdout + result.stderr)
      .join('');

    expect(output).not.toContain('npx');
  });
});
