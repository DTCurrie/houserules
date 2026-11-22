import { describe, expect, it } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { driftFor, runDoctorJson } from '#test/doctor-report';
import {
  editHouseConfig,
  manifestOf,
  writeManifest,
} from '#test/installed-tree';
import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_PLUGIN = join(KIT_ROOT, 'test/plugin-fixture');
const FIXTURE_SKILL = '.claude/skills/fixture-skill/SKILL.md';
const READY_SKILL = '.claude/skills/ready/SKILL.md';
const MANIFEST = '.claude/houserules.manifest.json';

function ensureFixtureSelfLink(): void {
  const link = join(FIXTURE_PLUGIN, 'node_modules', '@houserules', 'cli');
  if (existsSync(link)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(KIT_ROOT, link, 'dir');
}

function installedRepo(): string {
  ensureFixtureSelfLink();
  return useInstalledRepo('pnpm-monorepo', {
    modules: 'ready,code-cleanliness,fixture/fixture-core',
    plugins: [{ name: FIXTURE_PLUGIN, alias: 'fixture' }],
  });
}

function eject(root: string, dest: string): void {
  editHouseConfig(root, (config) => {
    config.ejected = [dest];
  });
}

function disableModule(root: string, moduleId: string): void {
  editHouseConfig(root, (config) => {
    config.modules = (config.modules as string[]).filter(
      (id) => id !== moduleId,
    );
  });
}

function forgeOlderRecordedHash(root: string, dest: string): void {
  const manifest = manifestOf(root);
  manifest.files[dest] =
    '0000000000000000000000000000000000000000000000000000000000000000';
  writeManifest(root, manifest);
}

describe('doctor, given an ejected file whose module is no longer enabled', () => {
  it('lists it as kept by you and exits 0', () => {
    const root = installedRepo();
    eject(root, READY_SKILL);
    disableModule(root, 'ready');
    runCli(['update', root]);

    const report = runDoctorJson(root);

    expect(driftFor(report, READY_SKILL)).toEqual({
      path: READY_SKILL,
      status: 'orphaned',
      yours: true,
    });
    expect(report.exitCode, JSON.stringify(report.findings)).toBe(0);
  });

  it('lists it and exits 0 on a clone whose first sync had no manifest', () => {
    const root = installedRepo();
    eject(root, READY_SKILL);
    rmSync(join(root, MANIFEST));
    disableModule(root, 'ready');
    runCli(['update', root]);

    const report = runDoctorJson(root);

    expect(driftFor(report, READY_SKILL)).toEqual({
      path: READY_SKILL,
      status: 'orphaned',
      yours: true,
    });
    expect(report.exitCode, JSON.stringify(report.findings)).toBe(0);
  });
});

describe('doctor --fix --force, given an edited ejected skill file', () => {
  it('leaves its bytes unchanged', () => {
    const root = installedRepo();
    eject(root, FIXTURE_SKILL);
    appendFileSync(join(root, FIXTURE_SKILL), '\nmy team edit\n');
    forgeOlderRecordedHash(root, FIXTURE_SKILL);
    const edited = readFileSync(join(root, FIXTURE_SKILL), 'utf8');

    runCli(['doctor', '--fix', '--force', root]);

    expect(readFileSync(join(root, FIXTURE_SKILL), 'utf8')).toBe(edited);
  });
});
