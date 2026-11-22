import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runCli, runIn } from '#test/run';
import {
  editHouseConfig,
  manifestOf,
  readClaudeMd,
  REGION_END,
  REGION_START,
  sha256,
  writeManifest,
} from '#test/installed-tree';

const TARGET = '.claude/houserules.md';
const IMPORT_REGION = `${REGION_START}\n\n@.claude/houserules.md\n\n${REGION_END}`;
const SECTIONS_HEADING = '### houserules sections';
// Joins the text before and after the region, so one string compares both halves.
const REGION_GAP = '\u0000';

function readTarget(root: string): string {
  return readFileSync(join(root, TARGET), 'utf8');
}

function textAroundRegion(text: string): { before: string; after: string } {
  const start = text.indexOf(REGION_START);
  const end = text.indexOf(REGION_END) + REGION_END.length;
  return { before: text.slice(0, start), after: text.slice(end) };
}

function legacyInstall(): { root: string; before: string } {
  const root = useInstalledRepo('npm-single');
  const sections = readTarget(root).trim();
  const { before, after } = textAroundRegion(readClaudeMd(root));
  writeFileSync(
    join(root, 'CLAUDE.md'),
    `${before}${REGION_START}\n\n${sections}\n\n${REGION_END}${after}`,
  );
  const manifest = manifestOf(root);
  manifest.files['CLAUDE.md'] = sha256(sections);
  writeManifest(root, manifest);
  rmSync(join(root, TARGET));
  return { root, before: outsideMarkers(root) };
}

function outsideMarkers(root: string): string {
  const { before, after } = textAroundRegion(readClaudeMd(root));
  return `${before}${REGION_GAP}${after}`;
}

describe('update on a CLAUDE.md region that holds the full sections', () => {
  it('replaces a pristine region with the import line and writes the target', () => {
    const { root, before } = legacyInstall();

    const result = runCli(['update', root]);

    expect(result.status, result.stderr).toBe(0);
    expect(readClaudeMd(root)).toContain(IMPORT_REGION);
    expect(readTarget(root)).toContain(SECTIONS_HEADING);
    expect(outsideMarkers(root)).toBe(before);
  });

  it('leaves an edited region byte for byte and prints its diff', () => {
    const { root } = legacyInstall();
    const edited = readClaudeMd(root).replace(
      REGION_END,
      `my edit\n${REGION_END}`,
    );
    writeFileSync(join(root, 'CLAUDE.md'), edited);

    const result = runCli(['update', root]);

    expect(readClaudeMd(root)).toBe(edited);
    expect(result.stdout).toContain('CLAUDE.md (managed block) (local edits');
    expect(result.stdout).toContain('--force to');
  });

  it('overwrites an edited region only under --force', () => {
    const { root } = legacyInstall();
    writeFileSync(
      join(root, 'CLAUDE.md'),
      readClaudeMd(root).replace(REGION_END, `my edit\n${REGION_END}`),
    );

    runCli(['update', '--force', root]);

    expect(readClaudeMd(root)).toContain(IMPORT_REGION);
  });
});

describe('update across a change to the rendered sections', () => {
  it('leaves git status clean and rewrites only the ignored target', () => {
    const root = useInstalledRepo('npm-single');
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'installed']);
    const before = readTarget(root);
    editHouseConfig(root, (config) => {
      config.guard = { gitCommit: false };
    });
    runIn(root, 'git', ['add', '-A']);
    runIn(root, 'git', ['commit', '-qm', 'config']);

    const result = runCli(['update', root]);

    expect(result.status, result.stderr).toBe(0);
    expect(readTarget(root)).not.toBe(before);
    expect(runIn(root, 'git', ['status', '--porcelain'])).toBe('');
  });
});

describe('update --sync on a fresh clone of a converted install', () => {
  it('restores the target and leaves CLAUDE.md alone', () => {
    const root = useInstalledRepo('npm-single');
    const claudeMd = readClaudeMd(root);
    const target = readTarget(root);
    rmSync(join(root, '.claude/houserules.manifest.json'));
    rmSync(join(root, TARGET));

    const result = runCli(['update', '--sync', root]);

    expect(result.status, result.stderr).toBe(0);
    expect(readClaudeMd(root)).toBe(claudeMd);
    expect(readTarget(root)).toBe(target);
  });
});

describe('eject of the import target', () => {
  it('takes the file out of the ignore block and tracks it', () => {
    const root = useInstalledRepo('npm-single');
    expect(readFileSync(join(root, '.claude/.gitignore'), 'utf8')).toContain(
      'houserules.md',
    );

    const result = runCli(['eject', '--yes', TARGET], { cwd: root });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(
      readFileSync(join(root, '.claude/.gitignore'), 'utf8'),
    ).not.toContain('houserules.md');
    expect(existsSync(join(root, TARGET))).toBe(true);
    expect(runIn(root, 'git', ['status', '--porcelain', TARGET])).toContain(
      'houserules.md',
    );
  });
});
