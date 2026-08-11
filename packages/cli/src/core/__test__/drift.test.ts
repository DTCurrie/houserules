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
  FORCE_ONLY,
  isClean,
  orphanDrift,
} from '../drift.js';
import type { DriftReport } from '../drift.js';
import type {
  BodyAction,
  CopyAction,
  FileAction,
  RegionAction,
  RegionSpec,
} from '@agent-kit/api';
import type { Effect } from '../../plan.js';

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

const KIT_LAST_WROTE = 'sha-of-the-version-the-kit-last-wrote';
const KIT_WOULD_WRITE_NOW = 'sha-of-the-version-the-kit-ships-today';

function effect(
  action: FileAction,
  op: Effect['op'],
  content = '',
  hash?: string,
): Effect {
  return { action, op, content: Buffer.from(content, 'utf8'), hash };
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

function bodyAction(overrides: Partial<BodyAction> = {}): BodyAction {
  return {
    kind: 'body',
    module: 'testing',
    src: '/payload/rules/testing.md',
    dest: '.claude/rules/testing.md',
    reason: 'body-owned rule',
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
      const result = classifyEffect(
        effect(copyAction(), op),
        neverCalled,
        KIT_LAST_WROTE,
      );
      expect(result.status).toBe('ok');
    },
  );

  it('does not call readHost for an "ok" effect', () => {
    let calls = 0;
    classifyEffect(
      effect(copyAction(), 'skip-exists'),
      () => {
        calls += 1;
        return null;
      },
      KIT_LAST_WROTE,
    );
    expect(calls).toBe(0);
  });

  it('reports "missing" for a create effect', () => {
    const result = classifyEffect(
      effect(copyAction(), 'create'),
      neverCalled,
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('missing');
  });

  it('does not call readHost for a "missing" effect', () => {
    let calls = 0;
    classifyEffect(
      effect(copyAction(), 'create'),
      () => {
        calls += 1;
        return null;
      },
      KIT_LAST_WROTE,
    );
    expect(calls).toBe(0);
  });

  it('reports a locally-edited non-region file the kit has not changed since as "yours"', () => {
    const result = classifyEffect(
      effect(copyAction(), 'skip-modified', 'canonical', KIT_LAST_WROTE),
      () => 'edited on disk',
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('yours');
    expect(result.yours).toBe(true);
  });

  it('reports a locally-edited non-region file the kit HAS changed since as "conflict"', () => {
    const result = classifyEffect(
      effect(copyAction(), 'skip-modified', 'canonical', KIT_WOULD_WRITE_NOW),
      () => 'edited on disk',
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('conflict');
  });

  it('still marks a "conflict" as your edit, so it cannot hold the exit code red', () => {
    const result = classifyEffect(
      effect(copyAction(), 'skip-modified', 'canonical', KIT_WOULD_WRITE_NOW),
      () => 'edited on disk',
      KIT_LAST_WROTE,
    );
    expect(result.yours).toBe(true);
  });

  it('falls back to "yours" for a local edit with no recorded hash to compare against', () => {
    const result = classifyEffect(
      effect(copyAction(), 'skip-modified', 'canonical', KIT_WOULD_WRITE_NOW),
      () => 'edited on disk',
      undefined,
    );
    expect(result.status).toBe('yours');
  });

  it('carries a diff against the canonical content for a "yours" non-region file', () => {
    const result = classifyEffect(
      effect(copyAction(), 'skip-modified', 'canonical', KIT_LAST_WROTE),
      () => 'edited on disk',
      KIT_LAST_WROTE,
    );
    expect(result.diff).toMatch(/edited on disk/);
  });

  it('reports a non-region file the kit itself would refresh as "stale" with yours false', () => {
    const result = classifyEffect(
      effect(copyAction(), 'update', 'new canonical', KIT_WOULD_WRITE_NOW),
      () => 'old canonical',
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('stale');
    expect(result.yours).toBeFalsy();
  });

  it('diffs against an empty string when readHost returns null for a non-region file', () => {
    const result = classifyEffect(
      effect(copyAction(), 'update', 'new canonical', KIT_WOULD_WRITE_NOW),
      () => null,
      KIT_LAST_WROTE,
    );
    expect(result.diff).toMatch(/new canonical/);
  });

  it('reports "no-marker" for a region whose host file is absent', () => {
    const result = classifyEffect(
      effect(regionAction(), 'update'),
      () => null,
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('no-marker');
  });

  it('reports "no-marker" for a region host file that has no markers', () => {
    const result = classifyEffect(
      effect(regionAction(), 'update'),
      () => 'some prose with no markers at all',
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('no-marker');
  });

  it('reports a locally-edited region the kit has not changed since as "yours", diffing only the region body', () => {
    const host = 'prefix\n<!-- start -->\nedited body\n<!-- end -->\nsuffix';
    const result = classifyEffect(
      effect(
        regionAction({ body: 'canonical body' }),
        'skip-modified',
        '',
        KIT_LAST_WROTE,
      ),
      () => host,
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('yours');
    expect(result.yours).toBe(true);
    expect(result.diff).toMatch(/edited body/);
    expect(result.diff).not.toMatch(/prefix/);
  });

  it('reports a locally-edited region the kit HAS changed since as "conflict"', () => {
    const host = 'prefix\n<!-- start -->\nedited body\n<!-- end -->\nsuffix';
    const result = classifyEffect(
      effect(
        regionAction({ body: 'canonical body' }),
        'skip-modified',
        '',
        KIT_WOULD_WRITE_NOW,
      ),
      () => host,
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('conflict');
  });

  it('reports a stale region diffing only the region body, not the surrounding prose', () => {
    const host = 'prefix\n<!-- start -->\nold body\n<!-- end -->\nsuffix';
    const result = classifyEffect(
      effect(
        regionAction({ body: 'new body' }),
        'update',
        '',
        KIT_WOULD_WRITE_NOW,
      ),
      () => host,
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('stale');
    expect(result.yours).toBeFalsy();
    expect(result.diff).toMatch(/old body/);
    expect(result.diff).not.toMatch(/suffix/);
  });

  it('reports "ok" for a body-owned file whose frontmatter differs but whose body matches canonical', () => {
    const host = '---\npaths: ["custom/**"]\n---\nshared body\n';
    const content = '---\npaths: ["custom/**"]\n---\nshared body\n';
    const result = classifyEffect(
      effect(bodyAction(), 'skip-identical', content),
      () => host,
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('ok');
  });

  it('reports "missing" for a body-owned file that is gone', () => {
    const result = classifyEffect(
      effect(bodyAction(), 'create'),
      neverCalled,
      undefined,
    );
    expect(result.status).toBe('missing');
  });

  it('reports a body-owned file whose body was edited but the kit has not changed since as "yours", diffing only the body', () => {
    const host = '---\npaths: ["custom/**"]\n---\nmy edited body\n';
    const content = '---\npaths: ["custom/**"]\n---\ncanonical body\n';
    const result = classifyEffect(
      effect(bodyAction(), 'skip-modified', content, KIT_LAST_WROTE),
      () => host,
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('yours');
    expect(result.yours).toBe(true);
    expect(result.diff).toMatch(/my edited body/);
    expect(result.diff).not.toMatch(/paths:/);
  });

  it('reports a body-owned file whose body was edited and the kit HAS changed since as "conflict"', () => {
    const host = '---\npaths: ["custom/**"]\n---\nmy edited body\n';
    const content = '---\npaths: ["custom/**"]\n---\ncanonical body\n';
    const result = classifyEffect(
      effect(bodyAction(), 'skip-modified', content, KIT_WOULD_WRITE_NOW),
      () => host,
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('conflict');
  });

  it('reports a body-owned file the kit itself would refresh as "stale", diffing only the body', () => {
    const host = '---\npaths: ["custom/**"]\n---\nold body\n';
    const content = '---\npaths: ["custom/**"]\n---\nnew body\n';
    const result = classifyEffect(
      effect(bodyAction(), 'update', content, KIT_WOULD_WRITE_NOW),
      () => host,
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('stale');
    expect(result.yours).toBeFalsy();
    expect(result.diff).toMatch(/old body/);
    expect(result.diff).toMatch(/new body/);
    expect(result.diff).not.toMatch(/paths:/);
  });
});

describe('classifyEffect, the "defaultMoved" annotation on a body action', () => {
  const HOST = '---\npaths: ["custom/**"]\n---\nshared body\n';
  const HOST_FRONTMATTER = '---\npaths: ["custom/**"]\n---\n';
  const CONTENT = '---\npaths: ["custom/**"]\n---\nshared body\n';

  it('is absent when the frontmatter matches the recorded default, i.e. it was never customized', () => {
    const result = classifyEffect(
      effect(bodyAction(), 'skip-identical', CONTENT),
      () => HOST,
      KIT_LAST_WROTE,
      sha256(HOST_FRONTMATTER),
    );
    expect(result.defaultMoved).toBeUndefined();
  });

  it('is absent when the frontmatter is customized but the shipped default has not moved', () => {
    const recordedDefault = sha256('---\npaths: ["old/**"]\n---\n');
    const result = classifyEffect(
      {
        ...effect(bodyAction(), 'skip-identical', CONTENT),
        frontmatterHash: recordedDefault,
      },
      () => HOST,
      KIT_LAST_WROTE,
      recordedDefault,
    );
    expect(result.defaultMoved).toBeUndefined();
  });

  it('is present, on an "ok"-status entry, when the frontmatter is customized and the shipped default has moved since', () => {
    const recordedDefault = sha256('---\npaths: ["old/**"]\n---\n');
    const shippedDefault = sha256('---\npaths: ["new/**"]\n---\n');
    const result = classifyEffect(
      {
        ...effect(bodyAction(), 'skip-identical', CONTENT),
        frontmatterHash: shippedDefault,
      },
      () => HOST,
      KIT_LAST_WROTE,
      recordedDefault,
    );
    expect(result.status).toBe('ok');
    expect(result.defaultMoved).toBe(true);
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

  it.each(['ok', 'yours', 'conflict', 'orphaned'] as const)(
    'excludes "%s"',
    (status) => {
      expect(FIXABLE).not.toContain(status);
    },
  );
});

describe('FORCE_ONLY', () => {
  it.each(['yours', 'conflict'] as const)('includes "%s"', (status) => {
    expect(FORCE_ONLY).toContain(status);
  });

  it.each(['ok', 'missing', 'stale', 'no-marker', 'orphaned'] as const)(
    'excludes "%s"',
    (status) => {
      expect(FORCE_ONLY).not.toContain(status);
    },
  );
});

function simulateKitContentMovedOn(root: string, relPath: string): void {
  const filePath = join(root, relPath);
  const tampered = `${readFileSync(filePath, 'utf8')}// kit changed upstream\n`;
  writeFileSync(filePath, tampered);
  const manifest = manifestOf(root);
  manifest.files[relPath] = sha256(tampered);
  writeManifest(root, manifest);
}

function simulateEditOnTopOfAnOlderKitVersion(
  root: string,
  relPath: string,
): void {
  appendFileSync(join(root, relPath), '// my tweak\n');
  const manifest = manifestOf(root);
  manifest.files[relPath] = sha256('what an older kit version wrote\n');
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

  it('raises no warning, since the kit has not changed the file since you edited it', () => {
    expect(runDoctorJson(root).counts.warnings).toBe(0);
  });
});

describe('a file edited locally that the kit has since changed (`conflict`)', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single');
    simulateEditOnTopOfAnOlderKitVersion(
      root,
      '.claude/scripts/guard-bash.mjs',
    );
  });

  it('is reported with status `conflict`', () => {
    const entry = driftFor(
      runDoctorJson(root),
      '.claude/scripts/guard-bash.mjs',
    );
    expect(entry?.status).toBe('conflict');
  });

  it('is still marked as your edit', () => {
    const entry = driftFor(
      runDoctorJson(root),
      '.claude/scripts/guard-bash.mjs',
    );
    expect(entry?.yours).toBe(true);
  });

  it('raises a warning, since a newer kit version leaves you a merge to make', () => {
    expect(runDoctorJson(root).counts.warnings).toBe(1);
  });

  it('does not hold the exit code red, since the file is still yours', () => {
    const report = runDoctorJson(root);
    expect(report.counts.blocking).toBe(0);
    expect(report.exitCode).toBe(0);
  });

  it('is left alone by --fix without --force', () => {
    const before = readFileSync(join(root, '.claude/scripts/guard-bash.mjs'));

    runCli(['doctor', root, '--fix']);

    expect(readFileSync(join(root, '.claude/scripts/guard-bash.mjs'))).toEqual(
      before,
    );
  });

  it('is reconciled to canonical by --fix --force', () => {
    runCli(['doctor', root, '--fix', '--force']);

    expect(
      readFileSync(join(root, '.claude/scripts/guard-bash.mjs'), 'utf8'),
    ).not.toMatch(/my tweak/);
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
      /\n*<!-- agent-kit:claude-md start -->[\s\S]*?<!-- agent-kit:claude-md end -->\n*/,
      '\n\nMY OWN PROSE MARKER\n\n',
    );
    writeFileSync(claudeMd, stripped);
  });

  it('is fixed by re-inserting the markers', () => {
    expect(runCli(['doctor', root, '--fix']).status).toBe(0);
    expect(readFileSync(claudeMd, 'utf8')).toContain(
      '<!-- agent-kit:claude-md start -->',
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
