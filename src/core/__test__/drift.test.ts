import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';
import { driftFor, runDoctorJson } from '#test/doctor-report';
import { manifestOf, sha256, writeManifest } from '#test/installed-tree';

import {
  classifyEffect,
  driftedFiles,
  FIXABLE,
  isClean,
  orphanDrift,
} from '../drift.js';
import type { DriftReport } from '../drift.js';
import type { CopyAction, FileAction, RegionAction } from '../../actions.js';
import type { Effect } from '../../plan.js';
import type { RegionSpec } from '../regions.js';

function copyAction(overrides: Partial<CopyAction> = {}): CopyAction {
  return {
    kind: 'copy',
    module: 'core',
    src: '/payload/guard.mjs',
    dest: '.claude/scripts/guard.mjs',
    reason: 'core script',
    ...overrides,
  };
}

function effect(action: FileAction, op: Effect['op'], content = ''): Effect {
  return { action, op, content: Buffer.from(content, 'utf8') };
}

const REGION: RegionSpec = {
  id: 'claude-md',
  start: '<!-- start -->',
  end: '<!-- end -->',
  anchor: 'eof',
};

function regionAction(overrides: Partial<RegionAction> = {}): RegionAction {
  return {
    kind: 'region',
    module: 'core',
    dest: 'CLAUDE.md',
    body: 'canonical body',
    region: REGION,
    reason: 'managed region',
    ...overrides,
  };
}

function neverCalled(): string | null {
  throw new Error('readHost should not have been called');
}

describe('classifyEffect', () => {
  it.each(['skip-exists', 'skip-identical'] as const)(
    'reports "ok" for a %s effect',
    (op) => {
      const result = classifyEffect(effect(copyAction(), op), neverCalled);
      expect(result.status).toBe('ok');
    },
  );

  it('does not call readHost for an "ok" effect', () => {
    let calls = 0;
    classifyEffect(effect(copyAction(), 'skip-exists'), () => {
      calls += 1;
      return null;
    });
    expect(calls).toBe(0);
  });

  it('reports "missing" for a create effect', () => {
    const result = classifyEffect(effect(copyAction(), 'create'), neverCalled);
    expect(result.status).toBe('missing');
  });

  it('does not call readHost for a "missing" effect', () => {
    let calls = 0;
    classifyEffect(effect(copyAction(), 'create'), () => {
      calls += 1;
      return null;
    });
    expect(calls).toBe(0);
  });

  it('reports a locally-edited non-region file as "yours" with yours set', () => {
    const result = classifyEffect(
      effect(copyAction(), 'skip-modified', 'canonical'),
      () => 'edited on disk',
    );
    expect(result.status).toBe('yours');
    expect(result.yours).toBe(true);
  });

  it('carries a diff against the canonical content for a "yours" non-region file', () => {
    const result = classifyEffect(
      effect(copyAction(), 'skip-modified', 'canonical'),
      () => 'edited on disk',
    );
    expect(result.diff).toMatch(/edited on disk/);
  });

  it('reports a non-region file the kit itself would refresh as "stale" with yours false', () => {
    const result = classifyEffect(
      effect(copyAction(), 'update', 'new canonical'),
      () => 'old canonical',
    );
    expect(result.status).toBe('stale');
    expect(result.yours).toBeFalsy();
  });

  it('diffs against an empty string when readHost returns null for a non-region file', () => {
    const result = classifyEffect(
      effect(copyAction(), 'update', 'new canonical'),
      () => null,
    );
    expect(result.diff).toMatch(/new canonical/);
  });

  it('reports "no-marker" for a region whose host file is absent', () => {
    const result = classifyEffect(effect(regionAction(), 'update'), () => null);
    expect(result.status).toBe('no-marker');
  });

  it('reports "no-marker" for a region host file that has no markers', () => {
    const result = classifyEffect(
      effect(regionAction(), 'update'),
      () => 'some prose with no markers at all',
    );
    expect(result.status).toBe('no-marker');
  });

  it('reports a locally-edited region as "yours" diffing only the region body', () => {
    const host = 'prefix\n<!-- start -->\nedited body\n<!-- end -->\nsuffix';
    const result = classifyEffect(
      effect(regionAction({ body: 'canonical body' }), 'skip-modified'),
      () => host,
    );
    expect(result.status).toBe('yours');
    expect(result.yours).toBe(true);
    expect(result.diff).toMatch(/edited body/);
    expect(result.diff).not.toMatch(/prefix/);
  });

  it('reports a stale region diffing only the region body, not the surrounding prose', () => {
    const host = 'prefix\n<!-- start -->\nold body\n<!-- end -->\nsuffix';
    const result = classifyEffect(
      effect(regionAction({ body: 'new body' }), 'update'),
      () => host,
    );
    expect(result.status).toBe('stale');
    expect(result.yours).toBeFalsy();
    expect(result.diff).toMatch(/old body/);
    expect(result.diff).not.toMatch(/suffix/);
  });
});

describe('orphanDrift', () => {
  it('reports a deleted-but-not-gone entry as "orphaned"', () => {
    const result = orphanDrift({
      deletes: [{ dest: '.claude/scripts/retired.mjs', gone: false }],
      kept: [],
      removedScripts: [],
    });
    expect(result).toEqual([
      { path: '.claude/scripts/retired.mjs', status: 'orphaned' },
    ]);
  });

  it('skips a delete entry that is already gone from disk', () => {
    const result = orphanDrift({
      deletes: [{ dest: '.claude/scripts/retired.mjs', gone: true }],
      kept: [],
      removedScripts: [],
    });
    expect(result).toEqual([]);
  });

  it('reports a kept (retired-but-edited) entry as "orphaned" with yours true', () => {
    const result = orphanDrift({
      deletes: [],
      kept: ['.claude/scripts/retired-edited.mjs'],
      removedScripts: [],
    });
    expect(result).toEqual([
      {
        path: '.claude/scripts/retired-edited.mjs',
        status: 'orphaned',
        yours: true,
      },
    ]);
  });

  it('returns an empty list for an absent prune result', () => {
    expect(orphanDrift(undefined)).toEqual([]);
  });
});

describe('isClean', () => {
  it('is true when every file is "ok"', () => {
    const report: DriftReport = {
      files: [
        { path: 'a', status: 'ok' },
        { path: 'b', status: 'ok' },
      ],
    };
    expect(isClean(report)).toBe(true);
  });

  it('is false when any file has drifted', () => {
    const report: DriftReport = {
      files: [
        { path: 'a', status: 'ok' },
        { path: 'b', status: 'stale' },
      ],
    };
    expect(isClean(report)).toBe(false);
  });
});

describe('driftedFiles', () => {
  it('filters out the "ok" entries', () => {
    const report: DriftReport = {
      files: [
        { path: 'a', status: 'ok' },
        { path: 'b', status: 'stale' },
        { path: 'c', status: 'missing' },
      ],
    };
    expect(driftedFiles(report).map((f) => f.path)).toEqual(['b', 'c']);
  });
});

describe('FIXABLE', () => {
  it.each(['missing', 'stale', 'no-marker'] as const)(
    'includes "%s"',
    (status) => {
      expect(FIXABLE).toContain(status);
    },
  );

  it.each(['ok', 'yours', 'orphaned'] as const)('excludes "%s"', (status) => {
    expect(FIXABLE).not.toContain(status);
  });
});

function simulateKitContentMovedOn(root: string, relPath: string): void {
  const filePath = join(root, relPath);
  const tampered = `${readFileSync(filePath, 'utf8')}// kit changed upstream\n`;
  writeFileSync(filePath, tampered);
  const manifest = manifestOf(root);
  manifest.files[relPath] = sha256(tampered);
  writeManifest(root, manifest);
}

describe('doctor on a clean install', () => {
  it('reports no drift and exits 0', () => {
    const root = useInstalledRepo('npm-single');
    const report = runDoctorJson(root);
    expect(report.counts.drifted, JSON.stringify(report.drift)).toBe(0);
    expect(report.ok).toBe(true);
  });
});

describe('a file edited locally (`yours`)', () => {
  let root: string;
  let guard: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single');
    guard = join(root, '.claude/scripts/guard-bash.mjs');
    appendFileSync(guard, '// my tweak\n');
  });

  it('is reported with status `yours`', () => {
    const entry = driftFor(
      runDoctorJson(root),
      '.claude/scripts/guard-bash.mjs',
    );
    expect(entry?.status).toBe('yours');
    expect(entry?.yours).toBe(true);
  });

  it('does not hold the exit code red, since a deliberate edit is not a blocking problem', () => {
    const report = runDoctorJson(root);
    expect(report.counts.blocking).toBe(0);
    expect(report.exitCode).toBe(0);
  });
});

describe('a file the kit would rewrite but was not edited (`stale`)', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single');
    simulateKitContentMovedOn(root, '.claude/scripts/guard-bash.mjs');
  });

  it('is reported with status `stale`, matching the manifest while differing from canonical', () => {
    const entry = driftFor(
      runDoctorJson(root),
      '.claude/scripts/guard-bash.mjs',
    );
    expect(entry?.status).toBe('stale');
    expect(entry?.yours).toBeFalsy();
  });

  it('blocks the exit code', () => {
    const report = runDoctorJson(root);
    expect(report.counts.blocking).toBe(1);
    expect(report.exitCode).toBe(1);
  });
});

describe('removing the CLAUDE.md markers (`no-marker`)', () => {
  let root: string;
  let claudeMd: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single');
    claudeMd = join(root, 'CLAUDE.md');
    const stripped = readFileSync(claudeMd, 'utf8').replace(
      /\n*<!-- claude-kit:claude-md start -->[\s\S]*?<!-- claude-kit:claude-md end -->\n*/,
      '\n\nMY OWN PROSE MARKER\n\n',
    );
    writeFileSync(claudeMd, stripped);
  });

  it('is fixed by re-inserting the markers', () => {
    expect(runCli(['doctor', root, '--fix']).status).toBe(0);
    expect(readFileSync(claudeMd, 'utf8')).toContain(
      '<!-- claude-kit:claude-md start -->',
    );
  });

  it('keeps the user prose intact when the markers are re-inserted', () => {
    runCli(['doctor', root, '--fix']);
    expect(readFileSync(claudeMd, 'utf8')).toContain('MY OWN PROSE MARKER');
  });
});

describe('an orphaned kit-owned file no enabled module produces', () => {
  let root: string;
  let stray: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single');

    stray = join(root, '.claude/scripts/retired-thing.mjs');
    mkdirSync(join(root, '.claude/scripts'), { recursive: true });
    writeFileSync(stray, 'export const x = 1;\n');
    const manifest = manifestOf(root);
    manifest.files['.claude/scripts/retired-thing.mjs'] = sha256(
      readFileSync(stray),
    );
    writeManifest(root, manifest);
  });

  it('is reported with status `orphaned`', () => {
    expect(
      driftFor(runDoctorJson(root), '.claude/scripts/retired-thing.mjs')
        ?.status,
    ).toBe('orphaned');
  });

  it('is not removed by --fix alone', () => {
    runCli(['doctor', root, '--fix']);
    expect(existsSync(stray)).toBe(true);
  });

  it('is removed by --fix --prune', () => {
    expect(runCli(['doctor', root, '--fix', '--prune']).status).toBe(0);
    expect(existsSync(stray)).toBe(false);
  });
});

describe('a shared host file', () => {
  it('is never proposed for deletion, since its manifest hash covers the managed region body rather than the whole file, so a hash forged against the whole file can never make it match', () => {
    const root = useInstalledRepo('npm-single');
    const manifest = manifestOf(root);
    manifest.files['CLAUDE.md'] = 'deadbeef';
    writeManifest(root, manifest);

    runCli(['doctor', root, '--fix', '--prune']);

    expect(existsSync(join(root, 'CLAUDE.md'))).toBe(true);
  });
});
