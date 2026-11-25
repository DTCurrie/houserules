import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';
import { driftFor, runDoctorJson } from '#test/doctor-report';
import {
  givePathTakingFixScripts,
  manifestOf,
  sha256,
  writeManifest,
} from '#test/installed-tree';

import {
  classifyEffect,
  computeDrift,
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
  WriteAction,
} from '@houserules/api';
import { computeEffects } from '../../plan.js';
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
  return {
    action,
    op,
    content: Buffer.from(content, 'utf8'),
    ...(hash !== undefined && { hash }),
  };
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

  it('reports a locally-edited non-region file houserules has not changed since as "yours"', () => {
    const result = classifyEffect(
      effect(copyAction(), 'skip-modified', 'canonical', KIT_LAST_WROTE),
      () => 'edited on disk',
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('yours');
    expect(result.yours, 'marked as your edit').toBe(true);
  });

  it('reports a locally-edited non-region file houserules HAS changed since as "conflict"', () => {
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
    expect(result.yours, 'marked as your edit').toBe(true);
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

  it('reports a non-region file houserules itself would refresh as "stale" with yours false', () => {
    const result = classifyEffect(
      effect(copyAction(), 'update', 'new canonical', KIT_WOULD_WRITE_NOW),
      () => 'old canonical',
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('stale');
    expect(result.yours, 'not marked as your edit').toBe(false);
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

  it('reports a locally-edited region houserules has not changed since as "yours", diffing only the region body', () => {
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
    expect(result.yours, 'marked as your edit').toBe(true);
    expect(result.diff).toMatch(/edited body/);
    expect(result.diff).not.toMatch(/prefix/);
  });

  it('reports a locally-edited region houserules HAS changed since as "conflict"', () => {
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
    expect(result.yours, 'not marked as your edit').toBe(false);
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

  it('reports a body-owned file whose body was edited but houserules has not changed since as "yours", diffing only the body', () => {
    const host = '---\npaths: ["custom/**"]\n---\nmy edited body\n';
    const content = '---\npaths: ["custom/**"]\n---\ncanonical body\n';
    const result = classifyEffect(
      effect(bodyAction(), 'skip-modified', content, KIT_LAST_WROTE),
      () => host,
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('yours');
    expect(result.yours, 'marked as your edit').toBe(true);
    expect(result.diff).toMatch(/my edited body/);
    expect(result.diff).not.toMatch(/paths:/);
  });

  it('reports a body-owned file whose body was edited and houserules HAS changed since as "conflict"', () => {
    const host = '---\npaths: ["custom/**"]\n---\nmy edited body\n';
    const content = '---\npaths: ["custom/**"]\n---\ncanonical body\n';
    const result = classifyEffect(
      effect(bodyAction(), 'skip-modified', content, KIT_WOULD_WRITE_NOW),
      () => host,
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('conflict');
  });

  it('reports a body-owned file houserules itself would refresh as "stale", diffing only the body', () => {
    const host = '---\npaths: ["custom/**"]\n---\nold body\n';
    const content = '---\npaths: ["custom/**"]\n---\nnew body\n';
    const result = classifyEffect(
      effect(bodyAction(), 'update', content, KIT_WOULD_WRITE_NOW),
      () => host,
      KIT_LAST_WROTE,
    );
    expect(result.status).toBe('stale');
    expect(result.yours, 'not marked as your edit').toBe(false);
    expect(result.diff).toMatch(/old body/);
    expect(result.diff).toMatch(/new body/);
    expect(result.diff).not.toMatch(/paths:/);
  });
});

describe('classifyEffect, given an older generated script under a newer manifest', () => {
  const SCRIPT = '.claude/scripts/guard.mjs';
  const RECORDED = sha256('copy the newer manifest recorded\n');

  function generatedScriptEffect(): Effect {
    const root = mkdtempSync(join(tmpdir(), 'kit-drift-generated-'));
    mkdirSync(join(root, '.claude/scripts'), { recursive: true });
    writeFileSync(join(root, SCRIPT), 'older generated copy\n');
    const actions: WriteAction[] = [
      {
        kind: 'write',
        module: 'core',
        dest: '.claude/scripts/.gitignore',
        content: '*\n',
        reason: 'self-gitignore',
      },
      {
        kind: 'write',
        module: 'core',
        dest: SCRIPT,
        content: 'canonical today\n',
        reason: 'core script',
      },
    ];
    const { effects } = computeEffects(root, actions, {
      manifest: {
        kitVersion: '1.0.0',
        installedAt: '2026-01-01T00:00:00.000Z',
        modules: ['core'],
        files: { [SCRIPT]: RECORDED },
      },
    });
    rmSync(root, { recursive: true, force: true });
    return effects.find((e) => e.action.dest === SCRIPT)!;
  }

  it('reports it "stale" for `update` to refresh, not "yours"', () => {
    const result = classifyEffect(
      generatedScriptEffect(),
      () => 'older generated copy\n',
      RECORDED,
    );

    expect(result.status).toBe('stale');
    expect(result.yours, 'not marked as your edit').toBe(false);
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
    expect(result.defaultMoved, 'default moved').toBe(true);
  });
});

describe('computeDrift, given a rule whose paths the config sets', () => {
  const DEST = '.claude/rules/example.md';
  const BODY = '\n# Example\n\nCurrent body.\n';
  const SHIPPED = "---\nname: example\npaths:\n  - '**/*.ts'\n---\n";
  const RENDERED = "---\nname: example\npaths:\n  - 'src/**'\n---\n";
  const RULE_PATHS = { example: ['src/**'] };
  let root: string;
  let src: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kit-drift-rule-paths-'));
    mkdirSync(join(root, '.claude/rules'), { recursive: true });
    src = join(root, 'payload-example.md');
    writeFileSync(src, SHIPPED + BODY);
    return () => rmSync(root, { recursive: true, force: true });
  });

  function manifestRecording(frontmatter: string) {
    return {
      kitVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
      modules: ['test'],
      files: {
        [DEST]: { body: sha256(BODY), frontmatter: sha256(frontmatter) },
      },
    };
  }

  function driftOf(
    manifest: ReturnType<typeof manifestRecording> | null,
    rulePaths: Record<string, string[]> = RULE_PATHS,
  ) {
    const action = bodyAction({ src, dest: DEST });
    const { effects } = computeEffects(root, [action], { manifest, rulePaths });
    return single(computeDrift(root, effects, { manifest }).files);
  }

  function single<T>(items: readonly T[]): T {
    expect(items).toHaveLength(1);
    return items[0] as T;
  }

  it('reads the rendered rule as clean, with no default-moved notice', () => {
    writeFileSync(join(root, DEST), RENDERED + BODY);

    const entry = driftOf(manifestRecording(SHIPPED));

    expect(entry.status).toBe('ok');
    expect(entry.defaultMoved).toBeUndefined();
  });

  it('reads the rendered rule as clean on a clone with no manifest', () => {
    writeFileSync(join(root, DEST), RENDERED + BODY);

    expect(driftOf(null).status).toBe('ok');
  });

  it('flags the default as moved, still clean, when the shipped paths changed since the last update', () => {
    writeFileSync(join(root, DEST), RENDERED + BODY);

    const entry = driftOf(
      manifestRecording("---\nname: example\npaths:\n  - '**/*.js'\n---\n"),
    );

    expect(entry.status).toBe('ok');
    expect(entry.defaultMoved, 'default moved').toBe(true);
  });

  it('reports a rule still carrying the shipped paths as stale, with the paths in the diff', () => {
    writeFileSync(join(root, DEST), SHIPPED + BODY);

    const entry = driftOf(manifestRecording(SHIPPED));

    expect(entry.status).toBe('stale');
    expect(entry.yours, 'not marked as your edit').toBe(false);
    expect(entry.diff).toMatch(/-\s+- '\*\*\/\*\.ts'/);
    expect(entry.diff).toMatch(/\+\s+- 'src\/\*\*'/);
  });

  it('reads a rule rendered for an earlier config value as stale rather than as your edit', () => {
    writeFileSync(join(root, DEST), RENDERED + BODY);

    const entry = driftOf(manifestRecording(SHIPPED), { example: ['lib/**'] });

    expect(entry.status).toBe('stale');
    expect(entry.yours, 'not marked as your edit').toBe(false);
  });
});

describe('orphanDrift', () => {
  it('reports a deleted-but-not-gone entry as "orphaned"', () => {
    const result = orphanDrift({
      deletes: [{ dest: '.claude/scripts/retired.mjs', gone: false }],
      kept: [],
      ejected: [],
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
      ejected: [],
      removedScripts: [],
    });
    expect(result).toEqual([]);
  });

  it('reports a kept (retired-but-edited) entry as "orphaned" with yours true', () => {
    const result = orphanDrift({
      deletes: [],
      kept: ['.claude/scripts/retired-edited.mjs'],
      ejected: [],
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

  it('reports a retired ejected entry as "orphaned" with yours true, so it never holds the exit code red', () => {
    const result = orphanDrift({
      deletes: [],
      kept: [],
      ejected: ['.claude/skills/ready/SKILL.md'],
      removedScripts: [],
    });
    expect(result).toEqual([
      {
        path: '.claude/skills/ready/SKILL.md',
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
    expect(isClean(report), 'report is clean').toBe(true);
  });

  it('is false when any file has drifted', () => {
    const report: DriftReport = {
      files: [
        { path: 'a', status: 'ok' },
        { path: 'b', status: 'stale' },
      ],
    };
    expect(isClean(report), 'report is not clean').toBe(false);
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
  const tampered = `${readFileSync(filePath, 'utf8')}// houserules changed upstream\n`;
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
  manifest.files[relPath] = sha256('what an older houserules version wrote\n');
  writeManifest(root, manifest);
}

describe('doctor on a clean install', () => {
  it('reports no drift and exits 0', () => {
    const root = useInstalledRepo('npm-single');
    const report = runDoctorJson(root);
    expect(report.counts.drifted, JSON.stringify(report.drift)).toBe(0);
    expect(report.ok, 'doctor report is ok').toBe(true);
  });
});

const EDITED_SKILL = '.claude/skills/ready/SKILL.md';

describe('a file edited locally (`yours`)', () => {
  let root: string;
  let skill: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single', { modules: 'ready' });
    givePathTakingFixScripts(root);
    skill = join(root, EDITED_SKILL);
    appendFileSync(skill, '// my tweak\n');
  });

  it('is reported with status `yours`', () => {
    const entry = driftFor(runDoctorJson(root), EDITED_SKILL);
    expect(entry?.status).toBe('yours');
    expect(entry?.yours, 'marked as your edit').toBe(true);
  });

  it('does not hold the exit code red, since a deliberate edit is not a blocking problem', () => {
    const report = runDoctorJson(root);
    expect(report.counts.blocking).toBe(0);
    expect(report.exitCode).toBe(0);
  });

  it('raises no warning, since houserules has not changed the file since you edited it', () => {
    expect(runDoctorJson(root).counts.warnings).toBe(0);
  });
});

describe('a file edited locally that houserules has since changed (`conflict`)', () => {
  let root: string;

  beforeEach(() => {
    root = useInstalledRepo('npm-single', { modules: 'ready' });
    givePathTakingFixScripts(root);
    simulateEditOnTopOfAnOlderKitVersion(root, EDITED_SKILL);
  });

  it('is reported with status `conflict`', () => {
    const entry = driftFor(runDoctorJson(root), EDITED_SKILL);
    expect(entry?.status).toBe('conflict');
  });

  it('is still marked as your edit', () => {
    const entry = driftFor(runDoctorJson(root), EDITED_SKILL);
    expect(entry?.yours, 'marked as your edit').toBe(true);
  });

  it('raises a warning, since a newer houserules version leaves you a merge to make', () => {
    expect(runDoctorJson(root).counts.warnings).toBe(1);
  });

  it('does not hold the exit code red, since the file is still yours', () => {
    const report = runDoctorJson(root);
    expect(report.counts.blocking).toBe(0);
    expect(report.exitCode).toBe(0);
  });

  it('is left alone by --fix without --force', () => {
    const before = readFileSync(join(root, EDITED_SKILL));

    runCli(['doctor', root, '--fix']);

    expect(readFileSync(join(root, EDITED_SKILL))).toEqual(before);
  });

  it('is reconciled to canonical by --fix --force', () => {
    runCli(['doctor', root, '--fix', '--force']);

    expect(readFileSync(join(root, EDITED_SKILL), 'utf8')).not.toMatch(
      /my tweak/,
    );
  });
});

describe('a file houserules would rewrite but was not edited (`stale`)', () => {
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
    expect(entry?.yours, 'not marked as your edit').toBe(false);
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
      /\n*<!-- houserules:claude-md start -->[\s\S]*?<!-- houserules:claude-md end -->\n*/,
      '\n\nMY OWN PROSE MARKER\n\n',
    );
    writeFileSync(claudeMd, stripped);
  });

  it('is fixed by re-inserting the markers', () => {
    expect(runCli(['doctor', root, '--fix']).status).toBe(0);
    expect(readFileSync(claudeMd, 'utf8')).toContain(
      '<!-- houserules:claude-md start -->',
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
    expect(existsSync(stray), 'stray file still present').toBe(true);
  });

  it('is removed by --fix --prune', () => {
    expect(runCli(['doctor', root, '--fix', '--prune']).status).toBe(0);
    expect(existsSync(stray), 'stray file removed').toBe(false);
  });
});

describe('a shared host file', () => {
  it('is never proposed for deletion, since its manifest hash covers the managed region body rather than the whole file, so a hash forged against the whole file can never make it match', () => {
    const root = useInstalledRepo('npm-single');
    const manifest = manifestOf(root);
    manifest.files['CLAUDE.md'] = 'deadbeef';
    writeManifest(root, manifest);

    runCli(['doctor', root, '--fix', '--prune']);

    expect(existsSync(join(root, 'CLAUDE.md')), 'CLAUDE.md not deleted').toBe(
      true,
    );
  });
});
