import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { treeHash, useInstalledRepo, useRepo } from '#test/repo';
import { runCli, runIn, type RunResult } from '#test/run';
import {
  claudeMdPath,
  editHouseConfig,
  type HouseManifestShape,
  houseConfigPath,
  manifestOf,
  readClaudeMd,
  readJson,
  REGION_END,
  REGION_START,
  sha256,
  writeManifest,
} from '#test/installed-tree';
import {
  COMMITTED_SCRIPTS,
  KIT_ROOT,
  KIT_VERSION,
  LINT_SCRIPT,
  makeLintScriptStale,
} from './update-test-support.js';

function checkIgnoreStatus(root: string, dest: string): number | null {
  return spawnSync('git', ['check-ignore', '-q', dest], { cwd: root }).status;
}

describe('update on an ejected dest', () => {
  it('leaves the ejected dest out of the gitignore block and keeps the rest ignored', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const ejected = '.claude/rules/code-cleanliness.md';
    const ignored = '.claude/houserules.manifest.json';
    editHouseConfig(root, (config) => {
      config.ejected = [ejected];
    });

    const result = runCli(['update', root]);

    expect(result.status, result.stderr).toBe(0);
    expect(runIn(root, 'git', ['ls-files', ejected, ignored]).trim()).toBe('');
    expect(checkIgnoreStatus(root, ejected)).toBe(1);
    expect(checkIgnoreStatus(root, ignored)).toBe(0);
  });
});

describe('update with a config from before `modules` was recorded', () => {
  it('validates and updates from the manifest', () => {
    const root = useInstalledRepo('npm-single');
    editHouseConfig(root, (config) => {
      delete config.modules;
    });
    const modulesBefore = manifestOf(root).modules;

    const result = runCli(['update', root]);

    expect(result.status, result.stderr).toBe(0);
    expect(manifestOf(root).modules).toEqual(modulesBefore);
    expect(
      readJson<{ modules?: string[] }>(houseConfigPath(root)).modules,
    ).toEqual(modulesBefore);
  });
});

describe('update on an installed rule whose body was edited', () => {
  it('keeps the edit and reports the file as modified', () => {
    const root = useInstalledRepo('npm-single', {
      modules: 'code-cleanliness',
    });
    const dest = '.claude/rules/code-cleanliness.md';
    appendFileSync(join(root, dest), '\nuser-added line\n');
    const edited = readFileSync(join(root, dest), 'utf8');

    const result = runCli(['update', root]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(root, dest), 'utf8')).toBe(edited);
    expect(result.stdout.replace(/[\s│]+/g, ' ')).toContain(
      'differ from what houserules last wrote',
    );
  });
});

describe('update on a CLAUDE.md edited outside the markers', () => {
  it('preserves prose added above and below the block byte-for-byte', () => {
    const root = useInstalledRepo('npm-single');

    const installed = readClaudeMd(root);
    const startIdx = installed.indexOf(REGION_START);
    const endIdx = installed.indexOf(REGION_END) + REGION_END.length;
    const prefix = installed.slice(0, startIdx);
    const suffix = installed.slice(endIdx);

    const editedPrefix = `${prefix}Extra note added above the block by the user.\n`;
    const editedSuffix = `${suffix}\nExtra note added below the block by the user.\n`;
    const edited = `${editedPrefix}${installed.slice(startIdx, endIdx)}${editedSuffix}`;
    writeFileSync(claudeMdPath(root), edited);

    expect(runCli(['update', root]).status).toBe(0);

    const after = readClaudeMd(root);
    expect(after.startsWith(editedPrefix), 'starts with edited prefix').toBe(
      true,
    );
    expect(after.endsWith(editedSuffix), 'ends with edited suffix').toBe(true);
    expect(after).toContain(REGION_START);
    expect(after).toContain(REGION_END);
  });
});

describe('update run twice in a row', () => {
  it('leaves CLAUDE.md byte-identical between the two runs', () => {
    const root = useInstalledRepo('npm-single');
    expect(runCli(['update', root]).status).toBe(0);
    const once = readClaudeMd(root);
    expect(runCli(['update', root]).status).toBe(0);
    expect(readClaudeMd(root)).toBe(once);
  });
});

describe('claudeMd.managed: false', () => {
  it('leaves an existing CLAUDE.md completely untouched by update', () => {
    const root = useInstalledRepo('npm-single');
    const pristine =
      '# single-app\n\nPre-existing user CLAUDE.md — houserules must never edit this.\n';
    writeFileSync(claudeMdPath(root), pristine);

    const configPath = join(root, '.claude/houserules.config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    config.claudeMd = { managed: false };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

    expect(runCli(['update', root]).status).toBe(0);
    expect(readClaudeMd(root)).toBe(pristine);
  });
});

const FIXTURE_PLUGIN = join(KIT_ROOT, 'test/plugin-fixture');
const OPTION_MODULE = 'fixture/fixture-langs';

function ensureFixtureSelfLink(): void {
  const link = join(FIXTURE_PLUGIN, 'node_modules', '@houserules', 'cli');
  if (existsSync(link)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(KIT_ROOT, link, 'dir');
}

describe('update against an install whose option selection was never recorded', () => {
  let root: string;

  beforeEach(() => {
    ensureFixtureSelfLink();
    root = useRepo('npm-single');
    runCli(['init', '--yes', root]);
    editHouseConfig(root, (config) => {
      (config as Record<string, unknown>).plugins = [
        { name: FIXTURE_PLUGIN, alias: 'fixture' },
      ];
    });
    runCli([
      'modules',
      '--yes',
      `--modules=${OPTION_MODULE}`,
      '--module-option',
      `${OPTION_MODULE}=alpha,beta`,
      root,
    ]);
    editHouseConfig(root, (config) => {
      delete (config as Record<string, unknown>).moduleOptions;
    });
  });

  it('exits 1 rather than retiring files the fallback selection would not produce', () => {
    expect(runCli(['update', root]).status).toBe(1);
  });

  it('leaves the file the unrecorded selection installed', () => {
    runCli(['update', root]);

    expect(
      existsSync(join(root, '.claude/fixture-lang-beta.md')),
      'fixture-lang-beta.md kept',
    ).toBe(true);
  });

  it('names the module and a runnable command that settles it', () => {
    const result = runCli(['update', root]);

    expect(result.stderr).toMatch(/No recorded option selection/);
    expect(result.stderr).toMatch(/--reconfigure=fixture\/fixture-langs/);
  });

  it('proceeds under --force, which accepts the defaults', () => {
    expect(runCli(['update', '--force', root]).status).toBe(0);
  });

  it('proceeds once the selection is recorded, keeping every selected file', () => {
    runCli([
      'modules',
      '--yes',
      `--reconfigure=${OPTION_MODULE}`,
      '--module-option',
      `${OPTION_MODULE}=alpha,beta`,
      root,
    ]);

    expect(runCli(['update', root]).status).toBe(0);

    expect(
      existsSync(join(root, '.claude/fixture-lang-beta.md')),
      'fixture-lang-beta.md kept',
    ).toBe(true);
  });
});

describe('update, given a plugin module whose payload-dist file is missing', () => {
  const unwrap = (text: string): string => text.replace(/\s+/g, ' ');
  let root: string;
  let pluginCopy: string;
  let missingRuleSrc: string;
  let result: RunResult;

  beforeEach(() => {
    ensureFixtureSelfLink();
    pluginCopy = mkdtempSync(join(tmpdir(), 'kit-broken-plugin-'));
    cpSync(FIXTURE_PLUGIN, pluginCopy, { recursive: true });
    root = useRepo('npm-single');
    runCli(['init', '--yes', root]);
    editHouseConfig(root, (config) => {
      (config as Record<string, unknown>).plugins = [
        { name: pluginCopy, alias: 'fixture' },
      ];
    });
    expect(
      runCli(['modules', '--yes', '--modules=fixture/fixture-core', root])
        .status,
    ).toBe(0);
    missingRuleSrc = join(pluginCopy, 'payload-dist/rules/fixture-rule.md');
    rmSync(missingRuleSrc);
    result = runCli(['update', root]);
  });

  afterEach(() => {
    rmSync(pluginCopy, { recursive: true, force: true });
  });

  it('exits 1, since the plugin was not fully refreshed', () => {
    expect(result.status).toBe(1);
  });

  it('names the plugin that owns the missing payload file', () => {
    expect(unwrap(result.stdout)).toContain(pluginCopy);
  });

  it('says a payload build produces the missing file', () => {
    expect(unwrap(result.stdout)).toMatch(/payload/i);
    expect(unwrap(result.stdout)).toMatch(/build/i);
  });

  it('keeps the missing payload path in the message byte for byte', () => {
    expect(result.stdout).toContain(missingRuleSrc);
  });

  it("still renders the healthy built-in modules' plan instead of aborting everything", () => {
    expect(unwrap(result.stdout)).toContain(
      'houserules files already up to date',
    );
  });

  it('keeps the missing path on the same line as its list marker', () => {
    expect(result.stdout).toContain(`- ${missingRuleSrc}`);
  });
});

describe('init, given a plugin module whose payload-dist file is missing', () => {
  const unwrap = (text: string): string => text.replace(/\s+/g, ' ');
  let root: string;
  let pluginCopy: string;
  let result: RunResult;

  beforeEach(() => {
    ensureFixtureSelfLink();
    pluginCopy = mkdtempSync(join(tmpdir(), 'kit-broken-plugin-init-'));
    cpSync(FIXTURE_PLUGIN, pluginCopy, { recursive: true });
    rmSync(join(pluginCopy, 'payload-dist/rules/fixture-rule.md'));
    root = useRepo('npm-single');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(
      join(root, '.claude/houserules.config.json'),
      JSON.stringify({
        version: 2,
        packageManager: 'npm',
        plugins: [{ name: pluginCopy, alias: 'fixture' }],
        targets: [],
      }),
    );
    result = runCli([
      'init',
      '--yes',
      '--modules=core,fixture/fixture-core',
      root,
    ]);
  });

  afterEach(() => {
    rmSync(pluginCopy, { recursive: true, force: true });
  });

  it('exits 1 rather than installing what it can', () => {
    expect(result.status).toBe(1);
  });

  it('names the plugin that owns the missing payload file', () => {
    expect(unwrap(result.stdout)).toContain(pluginCopy);
  });

  it('writes no manifest, so no module is recorded as installed without its files', () => {
    expect(
      existsSync(join(root, '.claude/houserules.manifest.json')),
      'no manifest written',
    ).toBe(false);
  });
});

describe('update on a consumer-less install with a ledger .gitignore from before the gating', () => {
  it('prunes the file and leaves no empty .claude/ledgers/ behind', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const ignoreContent = '*\n!.gitignore\n';
    mkdirSync(join(root, '.claude/ledgers'), { recursive: true });
    writeFileSync(join(root, '.claude/ledgers/.gitignore'), ignoreContent);
    const manifestPath = join(root, '.claude/houserules.manifest.json');
    const manifest = readJson<HouseManifestShape>(manifestPath);
    manifest.files['.claude/ledgers/.gitignore'] = sha256(ignoreContent);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    expect(runCli(['update', root]).status).toBe(0);

    expect(
      existsSync(join(root, '.claude/ledgers')),
      'empty .claude/ledgers not left behind',
    ).toBe(false);
    expect(
      readJson<HouseManifestShape>(manifestPath).files[
        '.claude/ledgers/.gitignore'
      ],
    ).toBe(undefined);
  });
});

describe('update on an install with a pre-relocation settings.json.bak', () => {
  it('moves it into .claude/backups/ unchanged', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    writeFileSync(join(root, '.claude/settings.json.bak'), 'pristine-bytes\n');

    expect(runCli(['update', root]).status).toBe(0);

    expect(
      existsSync(join(root, '.claude/settings.json.bak')),
      'stray backup moved',
    ).toBe(false);
    expect(
      readFileSync(join(root, '.claude/backups/settings.json.bak'), 'utf8'),
    ).toBe('pristine-bytes\n');
  });

  it('keeps the stray file when a backup already exists at the new location', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    writeFileSync(join(root, '.claude/settings.json.bak'), 'older-pristine\n');
    mkdirSync(join(root, '.claude/backups'), { recursive: true });
    writeFileSync(
      join(root, '.claude/backups/settings.json.bak'),
      'newer-backup\n',
    );

    expect(runCli(['update', root]).status).toBe(0);

    expect(readFileSync(join(root, '.claude/settings.json.bak'), 'utf8')).toBe(
      'older-pristine\n',
    );
    expect(
      readFileSync(join(root, '.claude/backups/settings.json.bak'), 'utf8'),
    ).toBe('newer-backup\n');
  });

  it('leaves the stray file alone on --dry-run', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    writeFileSync(join(root, '.claude/settings.json.bak'), 'pristine-bytes\n');

    expect(runCli(['update', '--dry-run', root]).status).toBe(0);

    expect(readFileSync(join(root, '.claude/settings.json.bak'), 'utf8')).toBe(
      'pristine-bytes\n',
    );
    expect(
      existsSync(join(root, '.claude/backups/settings.json.bak')),
      'no new backup written on dry-run',
    ).toBe(false);
  });
});

describe('update on a repo whose instructions file is AGENTS.md', () => {
  it('keeps the region in AGENTS.md and creates no CLAUDE.md', () => {
    const root = useRepo('non-js');
    writeFileSync(join(root, 'AGENTS.md'), '# agents\n');
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    expect(runCli(['update', root]).status).toBe(0);

    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain(REGION_START);
    expect(agents).toContain(REGION_END);
    expect(existsSync(claudeMdPath(root)), 'no CLAUDE.md created').toBe(false);
  });
});

describe('update on an install carrying a retired task-worker effort variant', () => {
  it('prunes the manifest-recorded task-worker-low.md', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });
    const staleContent = '---\nname: task-worker-low\n---\n';
    const stalePath = join(root, '.claude/agents/task-worker-low.md');
    writeFileSync(stalePath, staleContent);
    const manifestPath = join(root, '.claude/houserules.manifest.json');
    const manifest = readJson<HouseManifestShape>(manifestPath);
    manifest.files['.claude/agents/task-worker-low.md'] = sha256(staleContent);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    expect(runCli(['update', root]).status).toBe(0);

    expect(existsSync(stalePath), 'stale variant pruned').toBe(false);
    expect(
      existsSync(join(root, '.claude/agents/task-worker.md')),
      'task-worker kept',
    ).toBe(true);
  });
});

describe('update on a retired manifest destination that is a symlink', () => {
  const retired = '.claude/scripts/compact-tool-output.mjs';

  function plantLink(root: string, target: string, type?: 'dir'): void {
    const manifestPath = join(root, '.claude/houserules.manifest.json');
    const manifest = readJson<HouseManifestShape>(manifestPath);
    manifest.files[retired] = sha256('recorded\n');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    symlinkSync(target, join(root, retired), type);
  }

  it('leaves no entry at a dangling link', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    plantLink(root, join(root, 'deleted-target.mjs'));

    const r = runCli(['update', root]);

    expect(r.status, r.stderr).toBe(0);
    expect(lstatSync(join(root, retired), { throwIfNoEntry: false })).toBe(
      undefined,
    );
  });

  it('unlinks a forced directory link without touching the directory it points at', () => {
    const root = useInstalledRepo('pnpm-monorepo');
    const targetDir = join(root, 'linked-dir');
    mkdirSync(targetDir);
    writeFileSync(join(targetDir, 'keep.txt'), 'survives\n');
    plantLink(root, targetDir, 'dir');

    const r = runCli(['update', '--force', root]);

    expect(r.status, r.stderr).toBe(0);
    expect(lstatSync(join(root, retired), { throwIfNoEntry: false })).toBe(
      undefined,
    );
    expect(readFileSync(join(targetDir, 'keep.txt'), 'utf8')).toBe(
      'survives\n',
    );
  });
});

describe('update on an install whose manifest records a module without its requirement', () => {
  const SWEEP_SKILL = '.claude/skills/sweep/SKILL.md';
  let root: string;
  let filesBefore: string[];

  beforeEach(() => {
    root = useInstalledRepo('npm-single', { modules: 'orchestrate' });
    const manifest = manifestOf(root);
    manifest.modules = manifest.modules.filter((id) => id !== 'sweep');
    for (const dest of Object.keys(manifest.files)) {
      if (!dest.startsWith('.claude/skills/sweep/')) continue;
      delete manifest.files[dest];
      rmSync(join(root, dest), { force: true });
    }
    writeManifest(root, manifest);
    editHouseConfig(root, (config) => {
      config.modules = manifest.modules;
    });
    filesBefore = Object.keys(manifest.files);
  });

  it('installs the missing module', () => {
    const result = runCli(['update', root]);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, SWEEP_SKILL)), 'sweep skill installed').toBe(
      true,
    );
  });

  it('records the added module in the manifest', () => {
    runCli(['update', root]);

    expect(manifestOf(root).modules).toContain('sweep');
  });

  it('names the module that required it', () => {
    const result = runCli(['update', root]);

    expect(result.stdout + result.stderr).toContain(
      '  sweep, required by orchestrate',
    );
  });

  it('keeps every file the manifest recorded before', () => {
    runCli(['update', root]);

    const missing = filesBefore.filter((dest) => !existsSync(join(root, dest)));
    expect(missing).toEqual([]);
  });
});

describe('update on an install that predates both of orchestrate requirements', () => {
  const EDITED = '.claude/skills/orchestrate/SKILL.md';
  let root: string;
  let editedBytes: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single', { modules: 'orchestrate' });
    const manifest = manifestOf(root);
    manifest.modules = manifest.modules.filter(
      (id) => id !== 'sweep' && id !== 'plans',
    );
    for (const dest of Object.keys(manifest.files)) {
      if (
        !dest.startsWith('.claude/skills/sweep/') &&
        !dest.startsWith('.claude/skills/plan-project/') &&
        !dest.startsWith('.claude/skills/plans/')
      ) {
        continue;
      }
      delete manifest.files[dest];
      rmSync(join(root, dest), { force: true });
    }
    writeManifest(root, manifest);
    editHouseConfig(root, (config) => {
      config.modules = manifest.modules;
    });
    appendFileSync(join(root, EDITED), '\nuser-added line\n');
    editedBytes = readFileSync(join(root, EDITED), 'utf8');
  });

  it('installs both modules, records both, and keeps the user-edited file', () => {
    const result = runCli(['update', root]);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, '.claude/skills/sweep/SKILL.md'))).toBe(true);
    expect(existsSync(join(root, '.claude/skills/plan-project/SKILL.md'))).toBe(
      true,
    );
    expect(manifestOf(root).modules).toEqual(
      expect.arrayContaining(['sweep', 'plans']),
    );
    expect(readFileSync(join(root, EDITED), 'utf8')).toBe(editedBytes);
  });
});

describe('update retains a non-default option of a module another module requires', () => {
  const PLUGIN = join(KIT_ROOT, 'test/plugin-fixture/option-retention');

  it('keeps the recorded non-default selection across two updates', () => {
    const root = useRepo('npm-single');
    runCli(['init', '--yes', root]);
    editHouseConfig(root, (config) => {
      (config as Record<string, unknown>).plugins = [
        { name: PLUGIN, alias: 'ret' },
      ];
    });
    const init = runCli([
      'init',
      '--yes',
      '--modules=core,ret/needy',
      '--module-option',
      'ret/choosy=spicy',
      root,
    ]);
    expect(init.status, init.stderr).toBe(0);
    const recorded = (): unknown =>
      (
        readJson(join(root, '.claude/houserules.config.json')) as {
          moduleOptions: Record<string, string[]>;
        }
      ).moduleOptions['ret/choosy'];
    expect(recorded()).toEqual(['spicy']);

    const first = runCli(['update', root]);
    expect(first.status, first.stderr).toBe(0);
    expect(recorded(), 'after the first update').toEqual(['spicy']);

    const second = runCli(['update', root]);
    expect(second.status, second.stderr).toBe(0);
    expect(recorded(), 'after the second update').toEqual(['spicy']);
  });
});

describe('update on an install recording a module whose requirement no plugin supplies', () => {
  it('exits 1 with the unmet message and writes nothing', () => {
    const root = useRepo('npm-single');
    runCli(['init', '--yes', root]);
    editHouseConfig(root, (config) => {
      (config as Record<string, unknown>).plugins = [
        {
          name: join(KIT_ROOT, 'test/plugin-fixture/requires-unmet'),
          alias: 'unmet',
        },
      ];
    });
    const manifest = manifestOf(root);
    manifest.modules.push('unmet/needy');
    writeManifest(root, manifest);
    editHouseConfig(root, (config) => {
      config.modules = manifest.modules;
    });
    const before = treeHash(root);

    const result = runCli(['update', root]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Module "unmet/needy" requires "ghost-module", which no installed plugin supplies.\nInstall it: npm install -D @acme/ghost\n',
    );
    expect(treeHash(root)).toBe(before);
  });
});

describe('the manifest entry for a local plugin', () => {
  const MINIMAL_PLUGIN = join(KIT_ROOT, 'test/plugin-fixture/minimal');
  const manifestPath = (root: string): string =>
    join(root, '.claude/houserules.manifest.json');
  const cleanup: string[] = [];

  function installLocalPlugin(): string {
    const root = useRepo('npm-single');
    cpSync(MINIMAL_PLUGIN, join(root, 'plugins/minimal'), { recursive: true });
    runCli(['init', '--yes', root]);
    editHouseConfig(root, (config) => {
      (config as Record<string, unknown>).plugins = [
        { name: './plugins/minimal', alias: 'min' },
      ];
    });
    const init = runCli(['init', '--yes', root]);
    expect(init.status, init.stderr).toBe(0);
    return root;
  }

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records no string that holds the absolute install root', () => {
    const root = installLocalPlugin();

    const manifest = manifestOf(root) as { plugins?: unknown[] };
    expect(manifest.plugins, 'plugin recorded').toHaveLength(1);
    expect(readFileSync(manifestPath(root), 'utf8')).not.toContain(root);
  });

  it('records an npm-installed plugin without the absolute install root', () => {
    const root = useRepo('npm-single');
    cpSync(
      MINIMAL_PLUGIN,
      join(root, 'node_modules/@houserules/plugin-fixture-minimal'),
      { recursive: true },
    );
    runCli(['init', '--yes', root]);
    editHouseConfig(root, (config) => {
      (config as Record<string, unknown>).plugins = [
        { name: '@houserules/plugin-fixture-minimal', alias: 'min' },
      ];
    });
    const init = runCli(['init', '--yes', root]);
    expect(init.status, init.stderr).toBe(0);
    const update = runCli(['update', root]);
    expect(update.status, update.stderr).toBe(0);

    expect((manifestOf(root) as { plugins?: unknown }).plugins).toEqual([
      {
        name: '@houserules/plugin-fixture-minimal',
        alias: 'min',
        version: '1.0.0',
      },
    ]);
    expect(readFileSync(manifestPath(root), 'utf8')).not.toContain(root);
  });

  it('stays byte-identical when update runs from a different root', () => {
    const root = installLocalPlugin();
    const moved = mkdtempSync(join(tmpdir(), 'kit-moved-repo-'));
    cleanup.push(moved);
    cpSync(root, moved, { recursive: true });
    const before = readFileSync(manifestPath(moved), 'utf8');

    const result = runCli(['update', moved]);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(manifestPath(moved), 'utf8')).toBe(before);
  });

  it('rewrites a manifest that recorded dir once, then leaves it alone', () => {
    const root = installLocalPlugin();
    const manifest = manifestOf(root) as unknown as {
      plugins: Array<Record<string, unknown>>;
    };
    const [plugin] = manifest.plugins;
    if (!plugin) throw new Error('init recorded no plugin entry');
    plugin.dir = join(root, 'plugins/minimal');
    writeManifest(root, manifest as never);

    const first = runCli(['update', root]);
    expect(first.status, first.stderr).toBe(0);
    const rewritten = readFileSync(manifestPath(root), 'utf8');
    expect(rewritten).not.toContain('"dir"');
    expect(rewritten).not.toContain(root);

    const second = runCli(['update', root]);
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(manifestPath(root), 'utf8')).toBe(rewritten);
  });
});

function runCliConcurrently(args: string[]): Promise<RunResult> {
  const env = { ...process.env };
  delete env.NODE_PATH;
  return new Promise((settle) => {
    const child = spawn(
      process.execPath,
      [join(KIT_ROOT, 'bin/houserules.mjs'), ...args],
      { env },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (status) => settle({ status, stdout, stderr }));
  });
}

describe('update --sync', () => {
  describe('on a current install', () => {
    let root: string;
    let before: string;
    let result: RunResult;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo');
      before = treeHash(root);
      result = runCli(['update', '--sync', root]);
    });

    it('exits 0', () => {
      expect(result.status, result.stderr).toBe(0);
    });

    it('prints nothing on stdout or stderr', () => {
      expect({ stdout: result.stdout, stderr: result.stderr }).toEqual({
        stdout: '',
        stderr: '',
      });
    });

    it('leaves the bytes of every file unchanged', () => {
      expect(treeHash(root)).toBe(before);
    });
  });

  describe('on a stale install', () => {
    let root: string;
    let result: RunResult;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo');
      makeLintScriptStale(root);
      result = runCli(['update', '--sync', root]);
    });

    it('prints exactly the one synced line, counting the refreshed script and the manifest', () => {
      expect({ stdout: result.stdout, stderr: result.stderr }).toEqual({
        stdout: `[houserules] synced to ${KIT_VERSION}: 2 written, 0 kept (edited)\n`,
        stderr: '',
      });
    });

    it('refreshes the stale file, as a plain update does', () => {
      expect(readFileSync(join(root, LINT_SCRIPT), 'utf8')).toContain(
        'loadConfigSafe',
      );
    });
  });

  describe('on a stale install with a locally edited committed script', () => {
    let root: string;
    let guardPath: string;
    let edited: string;
    let result: RunResult;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', COMMITTED_SCRIPTS);
      makeLintScriptStale(root);
      guardPath = join(root, '.claude/scripts/guard-bash.mjs');
      appendFileSync(guardPath, '// my local tweak\n');
      edited = readFileSync(guardPath, 'utf8');
      result = runCli(['update', '--sync', root]);
    });

    it('counts the edited file as kept', () => {
      expect(
        result.stdout,
        'written counts the stale script, the manifest, and the pruned scripts/.gitignore that scripts.commit retires',
      ).toBe(
        `[houserules] synced to ${KIT_VERSION}: 3 written, 1 kept (edited)\n`,
      );
    });

    it('leaves the edit in place', () => {
      expect(readFileSync(guardPath, 'utf8')).toBe(edited);
    });
  });

  describe('on scripts committed before they were gitignored', () => {
    let root: string;
    let indexBefore: string;
    let result: RunResult;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo');
      runIn(root, 'git', ['add', '-f', '.claude/scripts']);
      runIn(root, 'git', ['commit', '-qm', 'committed scripts']);
      makeLintScriptStale(root);
      indexBefore = runIn(root, 'git', ['ls-files', '--stage']);
      result = runCli(['update', '--sync', root]);
    });

    it('exits 0', () => {
      expect(result.status, result.stderr).toBe(0);
    });

    it('leaves the git index exactly as it was, where a plain update would untrack the scripts', () => {
      expect(runIn(root, 'git', ['ls-files', '--stage'])).toBe(indexBefore);
    });
  });

  describe('on an install whose settings.json does not parse', () => {
    let result: RunResult;

    beforeEach(() => {
      const root = useInstalledRepo('pnpm-monorepo');
      writeFileSync(join(root, '.claude/settings.json'), '{ not json');
      result = runCli(['update', '--sync', root]);
    });

    it('exits 0, where a plain update exits 1', () => {
      expect(result.status, result.stderr).toBe(0);
    });

    it('prints one [houserules] line naming settings.json, and nothing on stderr', () => {
      expect(result.stdout).toMatch(
        /^\[houserules\] sync failed: \.claude\/settings\.json is not valid JSON[^\n]*\n$/,
      );
      expect(result.stderr).toBe('');
    });
  });

  describe('with --dry-run on a stale install', () => {
    let root: string;
    let before: string;
    let result: RunResult;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo');
      makeLintScriptStale(root);
      before = treeHash(root);
      result = runCli(['--dry-run', 'update', '--sync', root]);
    });

    it('prints one line naming what it would write, the manifest left out', () => {
      expect({ stdout: result.stdout, stderr: result.stderr }).toEqual({
        stdout: `[houserules] dry run, would sync to ${KIT_VERSION}: 1 to write, 0 kept (edited)\n`,
        stderr: '',
      });
    });

    it('writes nothing', () => {
      expect(treeHash(root)).toBe(before);
    });
  });

  describe('run twice at once in one checkout', () => {
    let root: string;
    let results: RunResult[];

    beforeEach(async () => {
      root = useInstalledRepo('pnpm-monorepo');
      makeLintScriptStale(root);
      const manifest = manifestOf(root);
      manifest.kitVersion = '0.0.1';
      writeManifest(root, manifest);
      results = await Promise.all([
        runCliConcurrently(['update', '--sync', root]),
        runCliConcurrently(['update', '--sync', root]),
      ]);
    });

    it('exits 0 from both runs', () => {
      expect(results.map((r) => r.status)).toEqual([0, 0]);
    });

    it('leaves every manifest dest on disk and the manifest parsing at the running version', () => {
      const manifest = JSON.parse(
        readFileSync(join(root, '.claude/houserules.manifest.json'), 'utf8'),
      ) as HouseManifestShape;

      expect(manifest.kitVersion).toBe(KIT_VERSION);
      expect(
        Object.keys(manifest.files).filter(
          (dest) => !existsSync(join(root, dest)),
        ),
        'manifest dests missing from disk',
      ).toEqual([]);
    });
  });

  describe('on a manifest recorded by a newer CLI than the one running', () => {
    let root: string;
    let first: RunResult;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo');
      const manifest = manifestOf(root);
      manifest.kitVersion = '99.0.0';
      writeManifest(root, manifest);
      first = runCli(['update', '--sync', root]);
    });

    it('reports rewriting only the manifest', () => {
      expect(first.stdout).toBe(
        `[houserules] synced to ${KIT_VERSION}: 1 written, 0 kept (edited)\n`,
      );
    });

    it('records the running version, not the newer one', () => {
      expect(manifestOf(root).kitVersion).toBe(KIT_VERSION);
    });

    it('prints nothing on the next sync, so a version check cannot loop', () => {
      const second = runCli(['update', '--sync', root]);

      expect({ stdout: second.stdout, stderr: second.stderr }).toEqual({
        stdout: '',
        stderr: '',
      });
    });
  });
});
