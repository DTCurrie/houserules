import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'payload-dist/scripts/payload-sync.mjs',
);
const MANIFEST = '.claude/houserules.manifest.json';

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kit-sync-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function stubCli(
  packageDir: string,
  version: string,
  argvFile: string,
): string {
  put(
    packageDir,
    'package.json',
    JSON.stringify({ name: '@houserules/cli', version }),
  );
  const bin = join(packageDir, 'bin/houserules.js');
  put(
    packageDir,
    'bin/houserules.js',
    `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, process.argv.slice(2).join(' '));
console.log('[houserules] synced 3 files');
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function writeManifest(
  root: string,
  manifest: Record<string, unknown> | string,
): void {
  put(
    root,
    MANIFEST,
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
  );
}

function nodeDir(): string {
  const dir = tmp();
  symlinkSync(process.execPath, join(dir, 'node'));
  return dir;
}

function run(root: string, pathDir: string = nodeDir()) {
  const path = `${pathDir}:/bin:/usr/bin`;
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: path, CLAUDE_PROJECT_DIR: root },
  });
  return { status: r.status, stdout: r.stdout.trim() };
}

describe('payload-sync.mjs', () => {
  let root: string;
  let argvFile: string;

  beforeEach(() => {
    root = tmp();
    argvFile = join(tmp(), 'argv');
    stubCli(join(root, 'node_modules/@houserules/cli'), '2.0.0', argvFile);
    mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
    symlinkSync(
      join(root, 'node_modules/@houserules/cli/bin/houserules.js'),
      join(root, 'node_modules/.bin/houserules'),
    );
    put(root, '.claude/scripts/a.mjs', 'x');
  });

  function current(
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      kitVersion: '2.0.0',
      files: { '.claude/scripts/a.mjs': 'h' },
      ...extra,
    };
  }

  const synced = (r: { stdout: string }) =>
    expect(r.stdout.split('\n')).toEqual([
      '[houserules] synced 3 files',
      expect.stringContaining('Restart the session'),
    ]);

  it('spawns nothing and prints nothing on a current install', () => {
    writeManifest(root, current());

    const r = run(root);

    expect(r).toEqual({ status: 0, stdout: '' });
    expect(existsSync(argvFile)).toBe(false);
  });

  it('syncs when the manifest kitVersion is older than the CLI', () => {
    writeManifest(root, current({ kitVersion: '1.0.0' }));

    const r = run(root);

    expect(r.status).toBe(0);
    synced(r);
    expect(readFileSync(argvFile, 'utf8')).toBe(`update --sync ${root}`);
  });

  it('syncs when a recorded dest is missing on disk', () => {
    writeManifest(
      root,
      current({ files: { '.claude/scripts/gone.mjs': 'h' } }),
    );

    const r = run(root);

    expect(r.status).toBe(0);
    synced(r);
    expect(readFileSync(argvFile, 'utf8')).toBe(`update --sync ${root}`);
  });

  it('syncs when the manifest is missing', () => {
    const r = run(root);

    expect(r.status).toBe(0);
    synced(r);
    expect(readFileSync(argvFile, 'utf8')).toBe(`update --sync ${root}`);
  });

  it('syncs when the manifest does not parse', () => {
    writeManifest(root, '{ nope');

    const r = run(root);

    expect(r.status).toBe(0);
    synced(r);
  });

  it('syncs when an installed plugin differs from the manifest version', () => {
    put(
      root,
      'node_modules/@houserules/plugin-x/package.json',
      JSON.stringify({ name: '@houserules/plugin-x', version: '3.0.0' }),
    );
    writeManifest(
      root,
      current({
        plugins: [
          { name: '@houserules/plugin-x', alias: 'x', version: '2.0.0' },
        ],
      }),
    );

    const r = run(root);

    expect(r.status).toBe(0);
    synced(r);
  });

  it('does not compare a plugin that has no package.json in node_modules', () => {
    writeManifest(
      root,
      current({
        plugins: [
          { name: '@houserules/plugin-y', alias: 'y', version: '2.0.0' },
        ],
      }),
    );

    expect(run(root)).toEqual({ status: 0, stdout: '' });
    expect(existsSync(argvFile)).toBe(false);
  });

  it('exits 0 and prints the child output when the sync child fails', () => {
    writeManifest(root, current({ kitVersion: '1.0.0' }));
    put(
      root,
      'node_modules/@houserules/cli/bin/houserules.js',
      '#!/usr/bin/env node\nconsole.log("[houserules] boom");\nprocess.exit(1);\n',
    );

    expect(run(root)).toEqual({ status: 0, stdout: '[houserules] boom' });
  });

  describe('with no local CLI', () => {
    let pathDir: string;

    beforeEach(() => {
      rmSync(join(root, 'node_modules'), { recursive: true, force: true });
      pathDir = nodeDir();
    });

    it('uses a global houserules found on PATH', () => {
      const globalPackage = join(tmp(), 'lib/node_modules/@houserules/cli');
      const bin = stubCli(globalPackage, '2.0.0', argvFile);
      symlinkSync(bin, join(pathDir, 'houserules'));
      writeManifest(root, current({ kitVersion: '1.0.0' }));

      const r = run(root, pathDir);

      expect(r.status).toBe(0);
      synced(r);
      expect(readFileSync(argvFile, 'utf8')).toBe(`update --sync ${root}`);
    });

    it('spawns nothing when the global CLI matches the manifest', () => {
      const globalPackage = join(tmp(), 'lib/node_modules/@houserules/cli');
      const bin = stubCli(globalPackage, '2.0.0', argvFile);
      symlinkSync(bin, join(pathDir, 'houserules'));
      writeManifest(root, current());

      expect(run(root, pathDir)).toEqual({ status: 0, stdout: '' });
      expect(existsSync(argvFile)).toBe(false);
    });

    it('prints an install hint without npx when no CLI exists', () => {
      writeManifest(root, current());

      const r = run(root, pathDir);

      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^\[houserules\] .*[Ii]nstall/);
      expect(r.stdout).not.toContain('npx');
      expect(existsSync(argvFile)).toBe(false);
    });
  });
});
