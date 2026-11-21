import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo, useRepo } from '#test/repo';
import { runCli } from '#test/run';

const WITH_DEPENDENCY = {
  name: 'fixture',
  devDependencies: { '@houserules/cli': '^1.0.0' },
};

function writeManifest(root: string, text: string): void {
  writeFileSync(join(root, 'package.json'), text);
}

function manifestText(root: string): string {
  return readFileSync(join(root, 'package.json'), 'utf8');
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe('init and the package.json prepare script', () => {
  it('adds a prepare script when none exists', () => {
    const root = useRepo('non-js');
    writeManifest(root, json(WITH_DEPENDENCY));
    const result = runCli(['init', '--yes', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(manifestText(root)).toBe(
      json({
        ...WITH_DEPENDENCY,
        scripts: { prepare: 'houserules update --sync' },
      }),
    );
  });

  it('appends to an existing prepare script', () => {
    const root = useRepo('non-js');
    const start = { ...WITH_DEPENDENCY, scripts: { prepare: 'husky' } };
    writeManifest(root, json(start));
    const result = runCli(['init', '--yes', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(manifestText(root)).toBe(
      json({
        ...WITH_DEPENDENCY,
        scripts: { prepare: 'husky && houserules update --sync' },
      }),
    );
  });

  it('leaves an already wired prepare script byte for byte', () => {
    const root = useRepo('non-js');
    const wired = json({
      ...WITH_DEPENDENCY,
      scripts: { prepare: 'houserules update --sync' },
    });
    writeManifest(root, wired);
    const result = runCli(['init', '--yes', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(manifestText(root)).toBe(wired);
  });

  it('leaves an unparseable package.json alone and says so', () => {
    const root = useRepo('non-js');
    writeManifest(root, '{ "name": ');
    const result = runCli(['init', '--yes', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(manifestText(root)).toBe('{ "name": ');
    expect(result.stdout).toContain('package.json does not parse');
    expect(result.stdout).toContain('left alone');
  });

  it('writes nothing and says why when @houserules/cli is not a dependency', () => {
    const root = useRepo('non-js');
    const bare = json({ name: 'fixture' });
    writeManifest(root, bare);
    const result = runCli(['init', '--yes', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(manifestText(root)).toBe(bare);
    expect(result.stdout).toContain(
      'no prepare script written, because @houserules/cli is not a dependency',
    );
  });

  it('shows the change on --dry-run and writes nothing', () => {
    const root = useRepo('non-js');
    const start = json({ ...WITH_DEPENDENCY, scripts: { prepare: 'husky' } });
    writeManifest(root, start);
    const result = runCli(['init', '--yes', '--dry-run', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(manifestText(root)).toBe(start);
    expect(result.stdout).toContain('scripts.prepare: "husky"');
    expect(result.stdout).toContain(
      'scripts.prepare: "husky && houserules update --sync"',
    );
  });

  it('does not record package.json in the manifest', () => {
    const root = useRepo('non-js');
    writeManifest(root, json(WITH_DEPENDENCY));
    runCli(['init', '--yes', root]);
    const manifest = readFileSync(
      join(root, '.claude/houserules.manifest.json'),
      'utf8',
    );
    expect(manifest).not.toContain('package.json');
  });
});

describe('update and the package.json prepare script', () => {
  it('adds a prepare script when none exists', () => {
    const root = useInstalledRepo('non-js');
    writeManifest(root, json(WITH_DEPENDENCY));
    const result = runCli(['update', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(manifestText(root)).toBe(
      json({
        ...WITH_DEPENDENCY,
        scripts: { prepare: 'houserules update --sync' },
      }),
    );
  });

  it('appends to an existing prepare script', () => {
    const root = useInstalledRepo('non-js');
    writeManifest(
      root,
      json({ ...WITH_DEPENDENCY, scripts: { prepare: 'husky' } }),
    );
    runCli(['update', root]);
    expect(manifestText(root)).toBe(
      json({
        ...WITH_DEPENDENCY,
        scripts: { prepare: 'husky && houserules update --sync' },
      }),
    );
  });

  it('leaves an already wired prepare script byte for byte', () => {
    const root = useInstalledRepo('non-js');
    const wired = json({
      ...WITH_DEPENDENCY,
      scripts: { prepare: 'houserules update --sync' },
    });
    writeManifest(root, wired);
    runCli(['update', root]);
    expect(manifestText(root)).toBe(wired);
  });

  it('leaves an unparseable package.json alone and says so', () => {
    const root = useInstalledRepo('non-js');
    writeManifest(root, '{ "name": ');
    const result = runCli(['update', root]);
    expect(manifestText(root)).toBe('{ "name": ');
    expect(result.stdout).toContain('package.json does not parse');
  });

  it('writes nothing and says why when @houserules/cli is not a dependency', () => {
    const root = useInstalledRepo('non-js');
    const bare = json({ name: 'fixture' });
    writeManifest(root, bare);
    const result = runCli(['update', root]);
    expect(manifestText(root)).toBe(bare);
    expect(result.stdout).toContain(
      'no prepare script written, because @houserules/cli is not a dependency',
    );
  });

  it('shows the change on --dry-run and writes nothing', () => {
    const root = useInstalledRepo('non-js');
    const start = json(WITH_DEPENDENCY);
    writeManifest(root, start);
    const result = runCli(['update', '--dry-run', root]);
    expect(manifestText(root)).toBe(start);
    expect(result.stdout).toContain(
      'scripts.prepare: "houserules update --sync"',
    );
  });

  it('never edits package.json under --sync', () => {
    const root = useInstalledRepo('non-js');
    const start = json(WITH_DEPENDENCY);
    writeManifest(root, start);
    const result = runCli(['update', '--sync', root]);
    expect(result.status, result.stderr).toBe(0);
    expect(manifestText(root)).toBe(start);
  });
});
