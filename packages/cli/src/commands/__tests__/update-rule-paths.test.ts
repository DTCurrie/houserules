import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useInstalledRepo, useRepo } from '#test/repo';
import { runCli, type RunResult } from '#test/run';
import { driftFor, runDoctorJson } from '#test/doctor-report';
import {
  editHouseConfig,
  manifestOf,
  sha256,
  writeManifest,
} from '#test/installed-tree';
import { splitFrontmatter } from '../../core/frontmatter.js';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE_PLUGIN = join(KIT_ROOT, 'test/plugin-fixture');

function ensureFixtureSelfLink(): void {
  const link = join(FIXTURE_PLUGIN, 'node_modules', '@houserules', 'cli');
  if (existsSync(link)) return;
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(KIT_ROOT, link, 'dir');
}

function setRulePaths(root: string, ruleId: string, paths: string[]): void {
  editHouseConfig(root, (config) => {
    config.rules = { [ruleId]: { paths } };
  });
}

function readRule(root: string, dest: string): string {
  return readFileSync(join(root, dest), 'utf8');
}

function checkIgnoreStatus(root: string, dest: string): number | null {
  return spawnSync('git', ['check-ignore', '-q', dest], { cwd: root }).status;
}

function updateOk(root: string): RunResult {
  const result = runCli(['update', root]);
  expect(result.status, result.stderr + result.stdout).toBe(0);
  return result;
}

describe('update, given config paths for a shipped rule that ships its own', () => {
  const dest = '.claude/rules/code-cleanliness.md';
  const rendered = "---\npaths:\n  - 'src/**/*.ts'\n  - 'scripts/*.mjs'\n---\n";
  let root: string;
  let shippedBody: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single', { modules: 'code-cleanliness' });
    shippedBody = splitFrontmatter(readRule(root, dest)).body;
    const { frontmatter } = splitFrontmatter(readRule(root, dest));
    const olderBody = '\n# Code Cleanliness\n\nAn older body.\n';
    writeFileSync(join(root, dest), frontmatter + olderBody);
    const manifest = manifestOf(root);
    (manifest.files as Record<string, unknown>)[dest] = {
      body: sha256(olderBody),
      frontmatter: sha256(frontmatter),
    };
    writeManifest(root, manifest);
    setRulePaths(root, 'code-cleanliness', ['src/**/*.ts', 'scripts/*.mjs']);
  });

  it('renders the config paths and refreshes the body', () => {
    updateOk(root);

    expect(readRule(root, dest)).toBe(rendered + shippedBody);
  });

  it('leaves the rendered rule byte for byte on a second update', () => {
    updateOk(root);
    const first = readRule(root, dest);

    updateOk(root);

    expect(readRule(root, dest)).toBe(first);
  });

  it("keeps recording the shipped frontmatter's hash, not the rendered one", () => {
    const shippedFrontmatter = (
      manifestOf(root).files[dest] as unknown as { frontmatter: string }
    ).frontmatter;

    updateOk(root);

    expect(manifestOf(root).files[dest]).toEqual({
      body: sha256(shippedBody),
      frontmatter: shippedFrontmatter,
    });
  });

  it('keeps the rule file ignored', () => {
    updateOk(root);

    expect(checkIgnoreStatus(root, dest)).toBe(0);
  });

  it('renders the config value on a run with no manifest and the rule file deleted', () => {
    rmSync(join(root, dest));
    rmSync(join(root, '.claude/houserules.manifest.json'));

    updateOk(root);

    expect(readRule(root, dest)).toBe(rendered + shippedBody);
  });

  it('is reported by doctor with no drift once rendered', () => {
    updateOk(root);

    const report = runDoctorJson(root);

    expect(driftFor(report, dest)?.status).toBe('ok');
    expect(report.counts.drifted, JSON.stringify(report.drift)).toBe(0);
    expect(
      (report.findings ?? []).filter((finding) => finding.msg.includes(dest)),
    ).toEqual([]);
  });
});

describe('update, given config paths for a plugin rule that ships none', () => {
  const dest = '.claude/rules/fixture-rule.md';
  const shippedFrontmatter = '---\ndescription:  A rule  with no globs\n---\n';
  const rendered =
    "---\ndescription:  A rule  with no globs\npaths:\n  - 'fixtures/**'\n---\n";
  const newBody = '\n# Fixture Rule\n\nA refreshed body.\n';
  let root: string;
  let pluginCopy: string;

  function writeShippedRule(body: string): void {
    writeFileSync(
      join(pluginCopy, 'payload-dist/rules/fixture-rule.md'),
      shippedFrontmatter + body,
    );
  }

  beforeEach(() => {
    ensureFixtureSelfLink();
    pluginCopy = mkdtempSync(join(tmpdir(), 'kit-rule-paths-plugin-'));
    cpSync(FIXTURE_PLUGIN, pluginCopy, { recursive: true });
    writeShippedRule('\n# Fixture Rule\n\nThe first body.\n');
    root = useRepo('npm-single');
    runCli(['init', '--yes', root]);
    editHouseConfig(root, (config) => {
      config.plugins = [{ name: pluginCopy, alias: 'fixture' }];
    });
    expect(
      runCli(['modules', '--yes', '--modules=fixture/fixture-core', root])
        .status,
    ).toBe(0);
    setRulePaths(root, 'fixture-rule', ['fixtures/**']);
    writeShippedRule(newBody);
  });

  afterEach(() => {
    rmSync(pluginCopy, { recursive: true, force: true });
  });

  it('adds the key below the shipped keys and refreshes the body', () => {
    updateOk(root);

    expect(readRule(root, dest)).toBe(rendered + newBody);
  });

  it('leaves the rendered rule byte for byte on a second update', () => {
    updateOk(root);

    updateOk(root);

    expect(readRule(root, dest)).toBe(rendered + newBody);
  });

  it('renders the config value on a run with no manifest and the rule file deleted', () => {
    rmSync(join(root, dest));
    rmSync(join(root, '.claude/houserules.manifest.json'));

    updateOk(root);

    expect(readRule(root, dest)).toBe(rendered + newBody);
  });

  it('is reported by doctor with no drift once rendered', () => {
    updateOk(root);

    expect(driftFor(runDoctorJson(root), dest)?.status).toBe('ok');
  });
});
