import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { driftFor, runDoctorJson } from '#test/doctor-report';
import { editHouseConfig, manifestOf } from '#test/installed-tree';
import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';
import { splitFrontmatter } from '../../core/frontmatter.js';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_PLUGIN = join(KIT_ROOT, 'test/plugin-fixture');
const FIXTURE_SKILL = '.claude/skills/fixture-skill/SKILL.md';
const FIXTURE_RULE = '.claude/rules/fixture-rule.md';
const READY_SKILL = '.claude/skills/ready/SKILL.md';
const TIDY_SKILL = '.claude/skills/tidy/SKILL.md';
const MANIFEST = '.claude/houserules.manifest.json';
const EDIT = '\nmy team edit\n';
const BUMP = '\nhouserules shipped a newer line\n';

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

function eject(root: string, ...dests: string[]): void {
  editHouseConfig(root, (config) => {
    config.ejected = dests;
  });
}

function pointAtPluginCopy(root: string, pluginCopy: string): void {
  editHouseConfig(root, (config) => {
    config.plugins = [{ name: pluginCopy, alias: 'fixture' }];
  });
}

function bumpFixtureSkill(pluginCopy: string): void {
  appendFileSync(
    join(pluginCopy, 'payload-dist/skills/fixture-skill/SKILL.md'),
    BUMP,
  );
}

function disableModule(root: string, moduleId: string): void {
  editHouseConfig(root, (config) => {
    config.modules = (config.modules as string[]).filter(
      (id) => id !== moduleId,
    );
  });
}

function read(root: string, dest: string): string {
  return readFileSync(join(root, dest), 'utf8');
}

function edit(root: string, dest: string): string {
  appendFileSync(join(root, dest), EDIT);
  return read(root, dest);
}

describe('update, given an ejected skill file that a kit bump moved under a local edit', () => {
  let pluginCopy: string;

  beforeEach(() => {
    pluginCopy = mkdtempSync(join(tmpdir(), 'kit-eject-plugin-'));
    cpSync(FIXTURE_PLUGIN, pluginCopy, { recursive: true });
  });

  afterEach(() => {
    rmSync(pluginCopy, { recursive: true, force: true });
  });

  it('keeps the edit and reads `conflict` with a diff in doctor --json', () => {
    const root = installedRepo();
    pointAtPluginCopy(root, pluginCopy);
    eject(root, FIXTURE_SKILL);
    const edited = edit(root, FIXTURE_SKILL);
    bumpFixtureSkill(pluginCopy);

    expect(runCli(['update', root]).status).toBe(0);

    expect(read(root, FIXTURE_SKILL)).toBe(edited);
    const entry = driftFor(runDoctorJson(root), FIXTURE_SKILL);
    expect(entry?.status).toBe('conflict');
    expect(entry?.diff).toContain('houserules shipped a newer line');
  });

  it('reads `conflict` on a clone whose first sync ran before the bump', () => {
    const root = installedRepo();
    pointAtPluginCopy(root, pluginCopy);
    eject(root, FIXTURE_SKILL);
    const edited = edit(root, FIXTURE_SKILL);
    rmSync(join(root, MANIFEST));

    runCli(['update', '--sync', root]);
    bumpFixtureSkill(pluginCopy);
    runCli(['update', '--sync', root]);

    expect(read(root, FIXTURE_SKILL), 'ejected edit kept').toBe(edited);
    expect(driftFor(runDoctorJson(root), FIXTURE_SKILL)?.status).toBe(
      'conflict',
    );
  });
});

describe('update --sync on a clone with no manifest', () => {
  it('keeps an edited ejected skill file and refreshes an edited un-ejected one', () => {
    const root = installedRepo();
    const canonicalTidy = read(root, TIDY_SKILL);
    eject(root, FIXTURE_SKILL);
    const edited = edit(root, FIXTURE_SKILL);
    edit(root, TIDY_SKILL);
    rmSync(join(root, MANIFEST));

    runCli(['update', '--sync', root]);

    expect(read(root, FIXTURE_SKILL), 'ejected edit kept').toBe(edited);
    expect(read(root, TIDY_SKILL), 'un-ejected edit refreshed').toBe(
      canonicalTidy,
    );
  });

  it('keeps the edited body of an ejected rule', () => {
    const root = installedRepo();
    eject(root, FIXTURE_RULE);
    const edited = edit(root, FIXTURE_RULE);
    rmSync(join(root, MANIFEST));

    runCli(['update', '--sync', root]);

    expect(splitFrontmatter(read(root, FIXTURE_RULE)).body).toBe(
      splitFrontmatter(edited).body,
    );
  });

  it('records the canonical hash for the kept ejected file', () => {
    const root = installedRepo();
    eject(root, FIXTURE_SKILL);
    edit(root, FIXTURE_SKILL);
    rmSync(join(root, MANIFEST));

    runCli(['update', '--sync', root]);

    expect(manifestOf(root).files[FIXTURE_SKILL]).toBe(
      'b559e3b0f019e62f6f8b9e4ef79b5e4a5d5e1f0b74f716b36cd6ec674dbf82ba',
    );
  });
});

describe('update, given an ejected file whose module is no longer enabled', () => {
  it('keeps the unedited file and names it in its output', () => {
    const root = installedRepo();
    eject(root, READY_SKILL);
    const before = read(root, READY_SKILL);
    disableModule(root, 'ready');

    const result = runCli(['update', root]);

    expect(result.status).toBe(0);
    expect(read(root, READY_SKILL)).toBe(before);
    expect(result.stdout).toContain(READY_SKILL);
  });

  it('keeps it and names it on a clone with no manifest', () => {
    const root = installedRepo();
    eject(root, READY_SKILL);
    const before = read(root, READY_SKILL);
    rmSync(join(root, MANIFEST));
    disableModule(root, 'ready');

    const result = runCli(['update', root]);

    expect(result.status).toBe(0);
    expect(read(root, READY_SKILL)).toBe(before);
    expect(result.stdout).toContain(READY_SKILL);
  });
});

describe('update --force, given an edited ejected skill file beside an edited un-ejected one', () => {
  it('keeps the ejected edit and refreshes the other', () => {
    const root = installedRepo();
    const canonicalTidy = read(root, TIDY_SKILL);
    eject(root, FIXTURE_SKILL);
    const edited = edit(root, FIXTURE_SKILL);
    edit(root, TIDY_SKILL);

    runCli(['update', '--force', root]);

    expect(read(root, FIXTURE_SKILL), 'ejected edit kept').toBe(edited);
    expect(read(root, TIDY_SKILL), 'un-ejected edit refreshed').toBe(
      canonicalTidy,
    );
  });
});
