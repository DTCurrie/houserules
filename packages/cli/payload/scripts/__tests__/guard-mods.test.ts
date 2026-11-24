import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { modGuardRefusalFor, modLocationsFrom } from '../guard-mods.mjs';
import { useInstalledRepo } from '#test/repo';
import { dispatchedScriptsFor } from '#test/installed-tree';

function layOutMod(dir: string, hooksJson: object): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(dir, 'hooks'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), '{"name":"m"}');
  writeFileSync(join(dir, 'hooks', 'hooks.json'), JSON.stringify(hooksJson));
}

describe('modGuardRefusalFor', () => {
  let scratch: string;
  let configDir: string;
  let repo: string;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'guard-mods-')));
    configDir = join(scratch, 'config');
    repo = join(scratch, 'repo');
    mkdirSync(join(configDir, 'dev-mods'), { recursive: true });
    mkdirSync(repo, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('refuses a write into the session mods folder in bypassPermissions mode, naming the folder', () => {
    const refusal = modGuardRefusalFor(
      join(configDir, 'dev-mods/3f2a/git-branch/hooks/register.js'),
      'bypassPermissions',
      repo,
      { configDir, pluginDirs: [] },
    );

    expect(refusal).toContain(
      `inside the Claude Code mod directory ${join(configDir, 'dev-mods')}`,
    );
  });

  it('refuses a relative path whose .. segments climb into the session mods folder', () => {
    const refusal = modGuardRefusalFor(
      '../config/dev-mods/3f2a/m/hooks/register.js',
      'auto',
      repo,
      { configDir, pluginDirs: [] },
    );

    expect(refusal).toMatch(/^houserules mod guard: /);
  });

  it('refuses a path that reaches the session mods folder through a symlink', () => {
    symlinkSync(join(configDir, 'dev-mods'), join(repo, 'innocent'));

    const refusal = modGuardRefusalFor(
      'innocent/3f2a/m/hooks/register.js',
      'auto',
      repo,
      { configDir, pluginDirs: [] },
    );

    expect(refusal).toContain(
      join(configDir, 'dev-mods/3f2a/m/hooks/register.js'),
    );
  });

  it('refuses a write into a CLAUDE_CODE_PLUGIN_DIRS entry', () => {
    const pluginDir = join(scratch, 'loaded-plugin');
    mkdirSync(pluginDir);

    const refusal = modGuardRefusalFor(
      join(pluginDir, 'hooks/register.ts'),
      'auto',
      repo,
      { configDir, pluginDirs: [pluginDir] },
    );

    expect(refusal).toContain(`mod directory ${pluginDir}`);
  });

  it('refuses a write anywhere inside a directory laid out as a mod', () => {
    const modDir = join(repo, 'tools/first-mod');
    layOutMod(modDir, { modules: ['./register.js'] });

    const refusal = modGuardRefusalFor(
      'tools/first-mod/hooks/register.js',
      'bypassPermissions',
      repo,
      { configDir, pluginDirs: [] },
    );

    expect(refusal).toContain(`mod directory ${modDir}`);
  });

  it('refuses a mod-folder write when the payload carries no permission mode', () => {
    const refusal = modGuardRefusalFor(
      join(configDir, 'dev-mods/3f2a/m/hooks/register.js'),
      undefined,
      repo,
      { configDir, pluginDirs: [] },
    );

    expect(refusal).toContain('loads without asking in this mode');
  });

  it.each(['default', 'acceptEdits'])(
    'lets a mod-folder write through in %s mode, where Claude Code prompts for it',
    (mode) => {
      expect(
        modGuardRefusalFor(
          join(configDir, 'dev-mods/3f2a/m/hooks/register.js'),
          mode,
          repo,
          { configDir, pluginDirs: [] },
        ),
      ).toBeNull();
    },
  );

  it('lets an ordinary source path through in bypassPermissions mode', () => {
    expect(
      modGuardRefusalFor('src/main.ts', 'bypassPermissions', repo, {
        configDir,
        pluginDirs: [],
      }),
    ).toBeNull();
  });

  it('lets a path that only names mods and dev-mods as data through', () => {
    expect(
      modGuardRefusalFor(
        'src/mods/dev-mods/register.js',
        'bypassPermissions',
        repo,
        { configDir, pluginDirs: [] },
      ),
    ).toBeNull();
  });

  it('lets a write into a plugin whose hooks.json declares no modules through', () => {
    layOutMod(join(repo, 'tools/plain-plugin'), { hooks: {} });

    expect(
      modGuardRefusalFor(
        'tools/plain-plugin/hooks/hooks.json',
        'bypassPermissions',
        repo,
        { configDir, pluginDirs: [] },
      ),
    ).toBeNull();
  });
});

describe('modLocationsFrom', () => {
  it('reads the config dir and splits CLAUDE_CODE_PLUGIN_DIRS on the path delimiter', () => {
    expect(
      modLocationsFrom({
        CLAUDE_CONFIG_DIR: '/cfg',
        CLAUDE_CODE_PLUGIN_DIRS: '/a:/b',
      }),
    ).toEqual({ configDir: '/cfg', pluginDirs: ['/a', '/b'] });
  });

  it('falls back to .claude under the home directory with no CLAUDE_CONFIG_DIR', () => {
    expect(modLocationsFrom({ HOME: '/home/u' }).configDir).toMatch(
      /\/\.claude$/,
    );
  });
});

describe('guard-mods.mjs', () => {
  const GUARD = '.claude/scripts/guard-mods.mjs';
  let root: string;
  let configDir: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
    configDir = realpathSync(mkdtempSync(join(tmpdir(), 'guard-mods-cfg-')));
    mkdirSync(join(configDir, 'dev-mods'));
  });

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true });
  });

  function runGuard(toolName: string, toolInput: Record<string, unknown>) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
    };
    delete env.NODE_PATH;
    delete env.CLAUDE_CODE_PLUGIN_DIRS;
    return spawnSync(process.execPath, [join(root, GUARD)], {
      cwd: root,
      input: JSON.stringify({
        cwd: root,
        permission_mode: 'auto',
        tool_name: toolName,
        tool_input: toolInput,
      }),
      encoding: 'utf8',
      env,
    });
  }

  it('is wired into the PreToolUse dispatch', () => {
    expect(dispatchedScriptsFor(root, 'PreToolUse')).toContain(
      'guard-mods.mjs',
    );
  });

  it.each([
    ['Write', { content: 'export function register() {}' }],
    ['Edit', { old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }] }],
  ])(
    'exits 2 with the reason on stderr for a %s into the session mods folder',
    (tool, rest) => {
      const r = runGuard(tool, {
        file_path: join(configDir, 'dev-mods/3f2a/m/hooks/register.js'),
        ...rest,
      });

      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/^houserules mod guard: /);
    },
  );

  it('exits 0 for a Write to an ordinary source file', () => {
    const r = runGuard('Write', {
      file_path: 'apps/studio/src/main.ts',
      content: 'x',
    });

    expect(r.status, r.stderr).toBe(0);
  });

  it('exits 0 for a Write to a path that only names mods as data', () => {
    const r = runGuard('Write', {
      file_path: 'docs/mods/dev-mods.md',
      content: 'x',
    });

    expect(r.status, r.stderr).toBe(0);
  });
});
