import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateHouseConfig } from '@houserules/api/internal';

import { treeHash, useInstalledRepo, useRepo } from '#test/repo';
import { runCli } from '#test/run';
import { houseConfigPath, readJson } from '#test/installed-tree';
import { init } from '../init.js';
import type { Flags } from '../../cli-contract.js';

/** Maps every file under root, `.git` excluded, to its content hash. */
function walk(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else
        out.set(
          relative(root, full),
          createHash('sha256').update(readFileSync(full)).digest('hex'),
        );
    }
  };
  visit(root);
  return out;
}

describe('init --yes --dry-run settings preview', () => {
  it('prints the settings merge line and a houserules hook line, and writes nothing', () => {
    const root = useRepo('npm-single');
    const before = treeHash(root);
    const result = runCli(['init', '--yes', '--dry-run', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('± .claude/settings.json');
    expect(result.stdout).toMatch(
      /\+ hook: [A-Za-z]+(\([^)]*\))?: [\w-]+\.mjs/,
    );
    expect(treeHash(root), 'dry run changed the tree').toBe(before);
  });
});

describe('init --yes --dry-run file preview', () => {
  // Paths a real init writes that the preview never names. Each must appear in the
  // walk and be absent from the preview, so a stale entry or a closed gap fails.
  const exceptions: string[] = [
    '.claude/backups/.gitignore',
    '.claude/backups/settings.json.bak',
    '.claude/houserules.manifest.json',
  ];

  it('names every path a real init creates or changes, apart from listed exceptions', () => {
    const previewRoot = useRepo('npm-single');
    const realRoot = useRepo('npm-single');
    const preview = runCli(['init', '--yes', '--dry-run', previewRoot]);
    expect(preview.status, preview.stderr).toBe(0);

    const before = walk(realRoot);
    const real = runCli(['init', '--yes', realRoot]);
    expect(real.status, real.stderr).toBe(0);
    const after = walk(realRoot);

    const touched = [...after.entries()]
      .filter(([path, hash]) => before.get(path) !== hash)
      .map(([path]) => path);
    expect(touched.length, 'init touched nothing').toBeGreaterThan(0);

    for (const path of touched) {
      if (exceptions.includes(path)) continue;
      expect(preview.stdout.includes(path), `preview never names ${path}`).toBe(
        true,
      );
    }
    for (const path of exceptions) {
      expect(
        touched,
        `stale exception ${path}: init no longer touches it`,
      ).toContain(path);
      expect(
        preview.stdout.includes(path),
        `closed gap ${path}: preview now names it`,
      ).toBe(false);
    }
  });
});

describe('init --yes package manager isolation', () => {
  it('creates no node_modules, keeps package-lock.json bytes, and adds no other lockfile', () => {
    const root = useRepo('npm-single');
    const lockBefore = readFileSync(join(root, 'package-lock.json'));
    const result = runCli(['init', '--yes', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
    expect(
      readFileSync(join(root, 'package-lock.json')).equals(lockBefore),
    ).toBe(true);
    for (const lock of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'])
      expect(existsSync(join(root, lock)), `${lock} appeared`).toBe(false);
  });
});

describe('init --yes config schema reference', () => {
  it('writes the published schema URL into the config of a repo that does not depend on the cli', () => {
    const root = useRepo('npm-single');
    const result = runCli(['init', '--yes', root]);
    expect(result.status, result.stderr).toBe(0);
    const config = readJson(houseConfigPath(root)) as { $schema?: string };
    expect(config.$schema).toBe(
      'https://github.com/DTCurrie/houserules/blob/main/schema/houserules.config.schema.json',
    );
  });
});

const COMPLETE_CONFIG = {
  version: 2,
  packageManager: 'npm',
  targets: [
    {
      name: 'single-app',
      prefix: 'SINGLEAPP',
      packageName: 'single-app',
      pathPrefix: '',
      sourcePath: 'src',
      label: 'Single App',
    },
  ],
};

function seedConfig(root: string, text: string): void {
  mkdirSync(dirname(houseConfigPath(root)), { recursive: true });
  writeFileSync(houseConfigPath(root), text);
}

const RECOVERY_HINT = 'delete the file and re-run init';

describe('init over a config the schema rejects', () => {
  const rows = [
    {
      name: 'a misspelled changesets key',
      args: ['--yes'],
      text: JSON.stringify({
        ...COMPLETE_CONFIG,
        changesets: { baseBranchh: 'main' },
      }),
      problem: 'changesets.baseBranchh is not a known changesets setting',
    },
    {
      name: 'unparseable JSON',
      args: ['--yes'],
      text: '{nope',
      problem: 'not valid JSON',
    },
    {
      name: 'a partial config with only instructionsFile',
      args: ['--yes'],
      text: JSON.stringify({ instructionsFile: 'AGENTS.md' }),
      problem: 'packageManager is required',
    },
    {
      name: 'a plugin entry naming a missing package with an unknown key',
      args: ['--yes'],
      text: JSON.stringify({
        ...COMPLETE_CONFIG,
        plugins: [{ name: './no-such-plugin', alias: 'nope', bogus: true }],
      }),
      problem: 'plugins.0.bogus is not a known field',
    },
    {
      name: 'a misspelled changesets key under --dry-run',
      args: ['--yes', '--dry-run'],
      text: JSON.stringify({
        ...COMPLETE_CONFIG,
        changesets: { baseBranchh: 'main' },
      }),
      problem: 'changesets.baseBranchh is not a known changesets setting',
    },
  ];

  it.each(rows)(
    'exits 2 naming the problem and writes nothing for $name',
    ({ args, text, problem }) => {
      const root = useRepo('npm-single');
      seedConfig(root, text);
      const before = treeHash(root);

      const result = runCli(['init', ...args, root]);

      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain(`houserules.config.json: ${problem}`);
      expect(result.stderr).toContain(RECOVERY_HINT);
      expect(treeHash(root), 'init changed the tree').toBe(before);
    },
  );
});

describe('init config validity of what it writes', () => {
  it('writes a config the schema accepts on a fresh repo', () => {
    const root = useRepo('npm-single');

    const result = runCli(['init', '--yes', root]);

    expect(result.status, result.stderr).toBe(0);
    expect(
      validateHouseConfig(readFileSync(houseConfigPath(root), 'utf8')),
    ).toEqual([]);
  });

  it('keeps a config the schema accepts when re-run over a valid seeded config', () => {
    const root = useRepo('npm-single');
    seedConfig(root, JSON.stringify(COMPLETE_CONFIG));

    const result = runCli(['init', '--yes', root]);

    expect(result.status, result.stderr).toBe(0);
    expect(
      validateHouseConfig(readFileSync(houseConfigPath(root), 'utf8')),
    ).toEqual([]);
  });

  it('stages a plugin-declaring installed repo past the config check', () => {
    const pluginProse = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../plugin-prose',
    );

    const root = useInstalledRepo('npm-single', {
      plugins: [{ name: pluginProse, alias: 'prose' }],
    });

    expect(
      validateHouseConfig(readFileSync(houseConfigPath(root), 'utf8')),
    ).toEqual([]);
  });
});

describe('init on an old Node', () => {
  it('returns 1 naming the minimum when Node 21 runs it', async () => {
    const root = useRepo('npm-single');
    const original = process.versions;
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    Object.defineProperty(process, 'versions', {
      value: { ...original, node: '21.0.0' },
      configurable: true,
    });

    let status: number;
    try {
      status = await init(root, {
        yes: true,
        dryRun: true,
        modules: '',
        kitVersion: '0.0.0',
      } as Flags);
    } finally {
      Object.defineProperty(process, 'versions', {
        value: original,
        configurable: true,
      });
    }

    expect(status).toBe(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain('>= 22');
    stderr.mockRestore();
  });
});
