/**
 * The drift engine end-to-end: what doctor reports, what `--fix` reconciles, and the
 * distinction the whole engine exists for. `stale` means the kit changed, so refresh it
 * without asking. `yours` means you changed it, so report it and never overwrite without
 * `--force`.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { makeFixture, runCli } from './fixtures.js';

interface JsonReport {
  ok: boolean;
  exitCode: number;
  drift: { path: string; status: string; yours?: boolean; diff?: string }[];
  counts: { drifted: number; blocking: number };
}

function jsonDoctor(root: string, ...extra: string[]): JsonReport {
  return JSON.parse(
    runCli(['doctor', root, '--json', ...extra]).stdout,
  ) as JsonReport;
}

function driftFor(report: JsonReport, path: string) {
  return report.drift.find((f) => f.path === path);
}

test('DF1: a clean install has no drift and exits 0', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const report = jsonDoctor(root);
    expect(report.counts.drifted, JSON.stringify(report.drift)).toBe(0);
    expect(report.ok).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DF2: a file YOU edited is `yours`, carries a diff, and does not block', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const guard = join(root, '.claude/scripts/guard-bash.mjs');
    appendFileSync(guard, '// my tweak\n');

    const report = jsonDoctor(root);
    const entry = driftFor(report, '.claude/scripts/guard-bash.mjs');
    expect(entry?.status).toBe('yours');
    expect(entry?.yours).toBe(true);
    expect(entry?.diff).toMatch(/my tweak/);
    expect(
      report.counts.blocking,
      'a deliberate edit must not hold the exit code red',
    ).toBe(0);
    expect(report.exitCode).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DF3: a file the kit would rewrite but you did NOT touch is `stale` and blocks', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    // Forge the manifest hash so the on-disk file matches what the kit "last wrote"
    // while differing from canonical. This is exactly the shape of a kit-side change.
    const guard = join(root, '.claude/scripts/guard-bash.mjs');
    const tampered = `${readFileSync(guard, 'utf8')}// kit changed upstream\n`;
    writeFileSync(guard, tampered);
    const manifestPath = join(root, '.claude/kit-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, string>;
    };
    manifest.files['.claude/scripts/guard-bash.mjs'] = createHash('sha256')
      .update(tampered)
      .digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const report = jsonDoctor(root);
    const entry = driftFor(report, '.claude/scripts/guard-bash.mjs');
    expect(entry?.status, 'matches the manifest, differs from canonical').toBe(
      'stale',
    );
    expect(entry?.yours).toBeFalsy();
    expect(report.counts.blocking).toBe(1);
    expect(report.exitCode).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DF4: --fix restores a stale file but leaves `yours` alone; --force takes it too', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const guard = join(root, '.claude/scripts/guard-bash.mjs');
    const canonical = readFileSync(guard, 'utf8');
    appendFileSync(guard, '// my tweak\n');

    // --fix alone: your edit survives.
    expect(runCli(['doctor', root, '--fix']).status).toBe(0);
    expect(readFileSync(guard, 'utf8')).toMatch(/my tweak/);

    // --fix --force: reconciled back to canonical.
    expect(runCli(['doctor', root, '--fix', '--force']).status).toBe(0);
    expect(readFileSync(guard, 'utf8')).toBe(canonical);
    expect(jsonDoctor(root).counts.drifted).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DF5: --fix recreates a missing file', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const guard = join(root, '.claude/scripts/guard-bash.mjs');
    rmSync(guard);

    expect(jsonDoctor(root).exitCode).toBe(1);
    expect(runCli(['doctor', root, '--fix']).status).toBe(0);
    expect(existsSync(guard)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DF6: removing the CLAUDE.md markers is `no-marker`; --fix re-inserts, prose intact', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    const claudeMd = join(root, 'CLAUDE.md');
    const stripped = readFileSync(claudeMd, 'utf8').replace(
      /\n*<!-- claude-kit:claude-md start -->[\s\S]*?<!-- claude-kit:claude-md end -->\n*/,
      '\n\nMY OWN PROSE MARKER\n\n',
    );
    writeFileSync(claudeMd, stripped);

    expect(driftFor(jsonDoctor(root), 'CLAUDE.md')?.status).toBe('no-marker');

    expect(runCli(['doctor', root, '--fix']).status).toBe(0);
    const fixed = readFileSync(claudeMd, 'utf8');
    expect(fixed).toContain('<!-- claude-kit:claude-md start -->');
    expect(fixed, 'the user prose survives re-insertion').toContain(
      'MY OWN PROSE MARKER',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DF7: an orphan is reported; --fix --prune removes it, --fix alone does not', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);

    // A kit-owned file the manifest records but no enabled module produces.
    const stray = join(root, '.claude/scripts/retired-thing.mjs');
    mkdirSync(join(root, '.claude/scripts'), { recursive: true });
    writeFileSync(stray, 'export const x = 1;\n');
    const manifestPath = join(root, '.claude/kit-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, string>;
    };
    manifest.files['.claude/scripts/retired-thing.mjs'] = createHash('sha256')
      .update(readFileSync(stray))
      .digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    expect(
      driftFor(jsonDoctor(root), '.claude/scripts/retired-thing.mjs')?.status,
    ).toBe('orphaned');

    runCli(['doctor', root, '--fix']);
    expect(existsSync(stray), '--fix alone never deletes').toBe(true);

    expect(runCli(['doctor', root, '--fix', '--prune']).status).toBe(0);
    expect(existsSync(stray)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('DF8: --prune and --force require --fix', () => {
  expect(runCli(['doctor', '--prune']).status).not.toBe(0);
  expect(runCli(['doctor', '--prune']).stderr).toMatch(
    /--prune requires --fix/,
  );
  expect(runCli(['doctor', '--force']).stderr).toMatch(
    /--force requires --fix/,
  );
});

test('DF9: a shared host file is never proposed for deletion', () => {
  const root = makeFixture('npm-single');
  try {
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    // Forge a manifest entry for CLAUDE.md that no plan item will match by hash.
    const manifestPath = join(root, '.claude/kit-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      files: Record<string, string>;
      modules: string[];
    };
    manifest.files['CLAUDE.md'] = 'deadbeef';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    runCli(['doctor', root, '--fix', '--prune']);
    expect(
      existsSync(join(root, 'CLAUDE.md')),
      'pruning must never delete a file the user owns',
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
