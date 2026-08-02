import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { treeHash, useInstalledRepo, useRepo } from '#test/repo';
import { runCli } from '#test/run';
import { allHookCommands, manifestOf, settingsOf } from '#test/installed-tree';
import { parseRequested } from '../modules.js';
import type { ModuleDef } from '../../module-def.js';

function installedWithReadGuard(): string {
  const root = useInstalledRepo('npm-single', { modules: 'read-guard' });
  expect(existsSync(join(root, '.claude/scripts/guard-read.mjs'))).toBe(true);
  expect(allHookCommands(root).some((c) => c.includes('guard-read.mjs'))).toBe(
    true,
  );
  return root;
}

const moduleDef = (id: string): ModuleDef => ({
  id,
  title: id,
  group: 'optional',
  hint: () => '',
  defaultEnabled: () => false,
  plan: () => [],
});

const available: ModuleDef[] = [
  moduleDef('terse-style'),
  moduleDef('changesets'),
];

describe('parseRequested', () => {
  it.each([
    {
      name: 'undefined flag',
      flag: undefined,
      chosen: [],
      unknown: [],
    },
    {
      name: 'empty string',
      flag: '',
      chosen: [],
      unknown: [],
    },
    {
      name: 'a single known id',
      flag: 'terse-style',
      chosen: ['terse-style'],
      unknown: [],
    },
    {
      name: 'several comma-separated known ids',
      flag: 'terse-style,changesets',
      chosen: ['terse-style', 'changesets'],
      unknown: [],
    },
    {
      name: 'a single unknown id',
      flag: 'nope',
      chosen: [],
      unknown: ['nope'],
    },
    {
      name: 'a mix of known and unknown ids',
      flag: 'terse-style,nope',
      chosen: ['terse-style'],
      unknown: ['nope'],
    },
    {
      name: 'whitespace around entries',
      flag: ' terse-style , changesets ',
      chosen: ['terse-style', 'changesets'],
      unknown: [],
    },
    {
      name: 'a trailing comma',
      flag: 'terse-style,',
      chosen: ['terse-style'],
      unknown: [],
    },
    {
      name: 'a doubled comma',
      flag: 'terse-style,,changesets',
      chosen: ['terse-style', 'changesets'],
      unknown: [],
    },
    {
      name: 'a repeated known id',
      flag: 'terse-style,terse-style',
      chosen: ['terse-style'],
      unknown: [],
    },
    {
      name: 'a repeated unknown id',
      flag: 'nope,nope',
      chosen: [],
      unknown: ['nope', 'nope'],
    },
  ])('$name', ({ flag, chosen, unknown }) => {
    expect(parseRequested(flag, available)).toEqual({ chosen, unknown });
  });
});

describe('modules command on an initialized pnpm monorepo', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('pnpm-monorepo');
  });

  it('does not install an off-by-default module before it is requested', () => {
    const manifest = manifestOf(root);
    expect(manifest.modules.includes('terse-style')).toBeFalsy();
    expect(
      existsSync(join(root, '.claude/output-styles/kit-terse.md')),
    ).toBeFalsy();
  });

  it('installs the module and records it in the manifest when requested', () => {
    const r = runCli(['modules', '--yes', '--modules=terse-style', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(
      existsSync(join(root, '.claude/output-styles/kit-terse.md')),
    ).toBeTruthy();
    const manifest = manifestOf(root);
    expect(manifest.modules.includes('terse-style')).toBeTruthy();
  });

  it('leaves doctor green after enabling a module', () => {
    expect(
      runCli(['modules', '--yes', '--modules=terse-style', root]).status,
    ).toBe(0);
    expect(runCli(['doctor', root]).status).toBe(0);
  });

  it('is a no-op on a second run requesting the same already-installed module', () => {
    expect(
      runCli(['modules', '--yes', '--modules=terse-style', root]).status,
    ).toBe(0);
    const before = treeHash(root);
    const again = runCli(['modules', '--yes', '--modules=terse-style', root]);
    expect(again.status).toBe(0);
    expect(treeHash(root), 'second run writes nothing').toBe(before);
  });

  it('previews the file it would add without writing, in --dry-run', () => {
    const before = treeHash(root);
    const r = runCli([
      'modules',
      '--yes',
      '--dry-run',
      '--modules=terse-style',
      root,
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/kit-terse\.md/);
    expect(treeHash(root), 'dry run writes nothing').toBe(before);
  });

  it('reports available modules without writing when given no selection', () => {
    const before = treeHash(root);
    const r = runCli(['modules', '--yes', root]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout, 'lists terse-style as available').toMatch(/terse-style/);
    expect(treeHash(root), 'listing writes nothing').toBe(before);
  });
});

describe('modules command on an uninitialized repo', () => {
  it('refuses to run and points at `npx claude-kit init`', () => {
    const root = useRepo('non-js');
    const r = runCli(['modules', root]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/npx claude-kit init/);
  });
});

describe('modules --disable', () => {
  let root: string;

  beforeEach(() => {
    root = installedWithReadGuard();
  });

  it('removes the disabled module’s script and unwires its hook', () => {
    const r = runCli(['modules', root, '--yes', '--disable', 'read-guard']);
    expect(r.status, r.stderr).toBe(0);

    expect(existsSync(join(root, '.claude/scripts/guard-read.mjs'))).toBe(
      false,
    );
    expect(
      allHookCommands(root).some((c) => c.includes('guard-read.mjs')),
    ).toBe(false);
  });

  it('drops the module from the manifest', () => {
    runCli(['modules', root, '--yes', '--disable', 'read-guard']);
    expect(manifestOf(root).modules).not.toContain('read-guard');
  });

  describe('other things a disable must not touch', () => {
    beforeEach(() => {
      const path = join(root, '.claude/settings.json');
      const settings = settingsOf(root);
      settings.hooks ??= {};
      settings.hooks.Stop ??= [];
      settings.hooks.Stop.push({
        hooks: [{ command: 'node ./my-own-stop-hook.js' }],
      });
      settings.permissions ??= {};
      settings.permissions.allow = [
        ...(settings.permissions.allow ?? []),
        'Bash(echo mine)',
      ];
      writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);

      expect(
        runCli(['modules', root, '--yes', '--disable', 'read-guard']).status,
      ).toBe(0);
    });

    it('keeps a hook the user added themselves', () => {
      expect(allHookCommands(root)).toContain('node ./my-own-stop-hook.js');
    });

    it('keeps another kit module’s hook wired', () => {
      expect(
        allHookCommands(root).some((c) => c.includes('guard-bash.mjs')),
      ).toBe(true);
    });

    it('keeps a permission entry the user added themselves', () => {
      expect(settingsOf(root).permissions?.allow).toContain('Bash(echo mine)');
    });
  });

  it('returns to the same settings document after enable, disable, then re-enable', () => {
    const enabled = readFileSync(join(root, '.claude/settings.json'), 'utf8');

    expect(
      runCli(['modules', root, '--yes', '--disable', 'read-guard']).status,
    ).toBe(0);
    expect(
      runCli(['modules', root, '--yes', '--modules', 'read-guard']).status,
    ).toBe(0);

    expect(existsSync(join(root, '.claude/scripts/guard-read.mjs'))).toBe(true);
    expect(
      allHookCommands(root).some((c) => c.includes('guard-read.mjs')),
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')),
    ).toEqual(JSON.parse(enabled));
  });

  it('refuses to disable core', () => {
    const r = runCli(['modules', root, '--yes', '--disable', 'core']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Cannot disable core/);
  });

  it('leaves core’s files in place when disabling core is refused', () => {
    runCli(['modules', root, '--yes', '--disable', 'core']);
    expect(existsSync(join(root, '.claude/scripts/guard-bash.mjs'))).toBe(true);
  });

  it('refuses an unknown module id rather than silently ignoring it', () => {
    const r = runCli(['modules', root, '--yes', '--disable', 'nope']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Unknown module/);
  });

  describe('a locally edited file', () => {
    let script: string;

    beforeEach(() => {
      script = join(root, '.claude/scripts/guard-read.mjs');
      writeFileSync(script, `${readFileSync(script, 'utf8')}\n// my edit\n`);
    });

    it('is kept on disable, since edits are never deleted without --force', () => {
      expect(
        runCli(['modules', root, '--yes', '--disable', 'read-guard']).status,
      ).toBe(0);
      expect(existsSync(script)).toBe(true);
      expect(readFileSync(script, 'utf8')).toMatch(/my edit/);
    });

    it('is removed once `update --force` sweeps the now-retired file, since the sweep is update’s job, not disable’s', () => {
      expect(
        runCli(['modules', root, '--yes', '--disable', 'read-guard']).status,
      ).toBe(0);
      expect(runCli(['update', root, '--force']).status).toBe(0);
      expect(existsSync(script)).toBe(false);
    });

    it('is removed immediately when --force is passed to the disable itself', () => {
      expect(
        runCli(['modules', root, '--yes', '--force', '--disable', 'read-guard'])
          .status,
      ).toBe(0);
      expect(existsSync(script)).toBe(false);
    });
  });

  it('writes nothing to disk in --dry-run mode', () => {
    const before = readFileSync(join(root, '.claude/settings.json'), 'utf8');
    expect(
      runCli(['modules', root, '--yes', '--dry-run', '--disable', 'read-guard'])
        .status,
    ).toBe(0);
    expect(existsSync(join(root, '.claude/scripts/guard-read.mjs'))).toBe(true);
    expect(readFileSync(join(root, '.claude/settings.json'), 'utf8')).toBe(
      before,
    );
  });
});
