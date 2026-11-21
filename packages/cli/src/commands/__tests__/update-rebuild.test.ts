import { describe, expect, it } from 'vitest';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';
import { editHouseConfig, manifestOf } from '#test/installed-tree';

function readTree(root: string, dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(root, full)] = readFileSync(full).toString('base64');
    }
  };
  walk(join(root, dir));
  return out;
}

function withoutTimestamp(manifest: Record<string, unknown>) {
  const { installedAt: _installedAt, ...rest } = manifest;
  return rest;
}

const KEPT = (dest: string): boolean =>
  dest === '.claude/settings.json' ||
  dest === '.claude/.gitignore' ||
  dest.endsWith('/.gitignore');

function recordModulesInConfig(root: string): void {
  const { modules } = manifestOf(root);
  editHouseConfig(root, (config) => {
    config.modules = modules;
  });
}

function stripManifest(root: string): void {
  const manifest = manifestOf(root);
  rmSync(join(root, '.claude/houserules.manifest.json'));
  for (const dest of Object.keys(manifest.files)) {
    if (!dest.startsWith('.claude/') || KEPT(dest)) continue;
    rmSync(join(root, dest), { force: true });
  }
}

describe('update on a clone with a config naming modules and no manifest', () => {
  it('restores every kit file byte for byte and records the same manifest', () => {
    const root = useInstalledRepo('npm-single', {
      modules: 'code-cleanliness',
    });
    recordModulesInConfig(root);
    const manifestBefore = manifestOf(root);
    const filesBefore = readTree(root, '.claude');
    expect(filesBefore['.claude/rules/code-cleanliness.md']).toBeDefined();
    stripManifest(root);
    expect(existsSync(join(root, '.claude/rules/code-cleanliness.md'))).toBe(
      false,
    );

    const result = runCli(['update', root]);

    expect(result.status, result.stderr).toBe(0);
    const MANIFEST = '.claude/houserules.manifest.json';
    const { [MANIFEST]: _after, ...filesAfter } = readTree(root, '.claude');
    const { [MANIFEST]: _before, ...expectedFiles } = filesBefore;
    expect(filesAfter).toEqual(expectedFiles);
    const after = manifestOf(root);
    expect(after.files).toEqual(manifestBefore.files);
    expect(after.modules).toEqual(manifestBefore.modules);
    expect(withoutTimestamp(after)).toEqual(withoutTimestamp(manifestBefore));
    expect(existsSync(join(root, '.claude/houserules.manifest.json'))).toBe(
      true,
    );
  });

  it('plans the same effects as the manifest that install wrote', () => {
    const withManifest = useInstalledRepo('npm-single', {
      modules: 'code-cleanliness',
    });
    const withoutManifest = useInstalledRepo('npm-single', {
      modules: 'code-cleanliness',
    });
    recordModulesInConfig(withManifest);
    recordModulesInConfig(withoutManifest);
    rmSync(join(withoutManifest, '.claude/houserules.manifest.json'));
    // The temp root and the installed-version line differ by design.
    const plan = (root: string): string =>
      runCli(['update', '--dry-run', root])
        .stdout.split(root)
        .join('<root>')
        .split('\n')
        .filter((line) => !line.includes('update (installed:'))
        .join('\n');

    const fromManifest = plan(withManifest);
    const fromConfig = plan(withoutManifest);

    expect(fromConfig).toBe(fromManifest);
  });
});
