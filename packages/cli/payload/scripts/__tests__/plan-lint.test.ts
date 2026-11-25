import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  checkBlastRadiusShape,
  checkFencedCodeShare,
  checkFixOnSubagentStop,
  checkNoPlanWorkspace,
  checkNotesReplaceStep,
  checkPhaseSchedule,
  checkPlanPaths,
  derivePathRoots,
  checkReviewFocus,
  checkRoadmapSync,
  checkBudget,
  checkSignals,
  checkSliceRowsAfterDone,
  checkSliceStatuses,
  checkWorkspacePhaseFlat,
  listImpactMaps,
  parseDomain,
  parseRoadmapPhases,
  parseSignals,
} from '../plan-lint.mjs';

import { repoRootSafe } from '@houserules/payload/config';
import { useInstalledRepo, useRepo } from '#test/repo';
import { runScript } from '#test/run';

const SLICE_TABLE = (status: string) => `## Slices

| id  | owns          | depends | wave | status |
| --- | ------------- | ------- | ---- | ------ |
| 1a  | \`src/a.ts\`  | —       | 1    | ${status} |
`;

describe('checkSliceStatuses', () => {
  it('accepts a status from the fixed vocabulary', () => {
    const report = checkSliceStatuses('phase-1.md', SLICE_TABLE('DONE'));
    expect(report.findings).toEqual([]);
  });

  it('accepts a vocabulary status with a trailing parenthetical', () => {
    const report = checkSliceStatuses(
      'phase-1.md',
      SLICE_TABLE('DONE (1 revise)'),
    );
    expect(report.findings).toEqual([]);
  });

  it('flags a status outside the vocabulary', () => {
    const report = checkSliceStatuses('phase-1.md', SLICE_TABLE('In Progress'));
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-lint/slice-status-vocabulary');
    expect(report.findings[0]?.msg).toContain('In Progress');
  });
});

describe('checkSliceRowsAfterDone', () => {
  const phaseOf = (header: string, ...statuses: string[]) =>
    [
      '# Phase 3',
      '',
      `**Status:** ${header}`,
      '',
      '## Slices',
      '',
      '| id | owns | status |',
      '| -- | ---- | ------ |',
      ...statuses.map(
        (status, index) => `| 3${'abc'[index]} | x | ${status} |`,
      ),
      '',
    ].join('\n');

  it('flags the one non-terminal row under a DONE header, at its line', () => {
    const report = checkSliceRowsAfterDone(
      'phase-3.md',
      phaseOf('DONE (2026-11-18)', 'DONE', 'DISPATCHED'),
    );
    expect(report.findings).toEqual([
      {
        rule: 'plan-lint/slice-row-after-done',
        level: 'warn',
        file: 'phase-3.md',
        line: 10,
        msg: 'slice `3b` is `DISPATCHED` but the phase is `DONE`',
      },
    ]);
  });

  it('flags BLOCKED too', () => {
    const report = checkSliceRowsAfterDone(
      'phase-3.md',
      phaseOf('DONE', 'BLOCKED'),
    );
    expect(report.findings).toHaveLength(1);
  });

  it('reports nothing when every row is DONE', () => {
    const report = checkSliceRowsAfterDone(
      'phase-3.md',
      phaseOf('DONE', 'DONE', 'DONE (1 revise)'),
    );
    expect(report.findings).toEqual([]);
  });

  it('reports nothing when the header is not DONE', () => {
    const report = checkSliceRowsAfterDone(
      'phase-3.md',
      phaseOf('IN PROGRESS', 'TODO'),
    );
    expect(report.findings).toEqual([]);
  });
});

describe('checkRoadmapSync', () => {
  const roadmap = `## Phases

- [x] **Phase 1 — Foo** · Status: DONE (2026-08-18) · [sub-plan](phase-1-foo.md)
`;

  it('reports nothing when the sub-plan status matches', () => {
    const report = checkRoadmapSync('ROADMAP.md', roadmap, {
      'phase-1-foo.md': 'DONE (2026-08-18)',
    });
    expect(report.findings).toEqual([]);
  });

  it('flags a ROADMAP status that disagrees with the sub-plan header', () => {
    const report = checkRoadmapSync('ROADMAP.md', roadmap, {
      'phase-1-foo.md': 'TODO',
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-lint/roadmap-subplan-sync');
    expect(report.findings[0]?.msg).toContain('DONE (2026-08-18)');
    expect(report.findings[0]?.msg).toContain('TODO');
  });
});

describe('checkFixOnSubagentStop', () => {
  it('reports nothing when the field is unset', () => {
    const report = checkFixOnSubagentStop({ targets: [] });
    expect(report.findings).toEqual([]);
  });

  it('flags fix.onSubagentStop set to true', () => {
    const report = checkFixOnSubagentStop({
      targets: [],
      fix: { onSubagentStop: true },
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-lint/fix-on-subagent-stop');
  });
});

describe('checkBlastRadiusShape', () => {
  const complete = `# Blast radius — auth — 2026-08-18

> Snapshot at commit \`abc123\` on 2026-08-18.

## Surface

x

## Impact by file

x

## Cross-package / boundary impact

x

## Completeness self-audit

- **Coverage:** HIGH
`;

  it('reports nothing on a complete map', () => {
    const report = checkBlastRadiusShape(
      'blast-radius-auth-2026-08-18.md',
      complete,
    );
    expect(report.findings).toEqual([]);
  });

  it('flags a map missing a required section and the disclaimer', () => {
    const incomplete = `# Blast radius — auth — 2026-08-18

## Surface

x
`;
    const report = checkBlastRadiusShape(
      'blast-radius-auth-2026-08-18.md',
      incomplete,
    );
    const rules = report.findings.map((f) => f.msg);
    expect(
      rules.some((m) => m.includes('Impact by file')),
      'flags missing Impact by file',
    ).toBe(true);
    expect(
      rules.some((m) => m.includes('Completeness self-audit')),
      'flags missing Completeness self-audit',
    ).toBe(true);
    expect(
      rules.some((m) => m.includes('staleness disclaimer')),
      'flags missing staleness disclaimer',
    ).toBe(true);
  });
});

describe('listImpactMaps', () => {
  function stagePlansDir(files: string[]): string {
    const plansDir = join(useRepo('non-js'), '.claude/plans');
    for (const file of files) {
      const filePath = join(plansDir, file);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, '');
    }
    return plansDir;
  }

  it('finds a map inside the workspace of the plan it served', () => {
    const plansDir = stagePlansDir([
      'auth-rework/ROADMAP.md',
      'auth-rework/blast-radius-session-store-2026-08-18.md',
    ]);
    expect(listImpactMaps(plansDir, ['auth-rework'])).toEqual([
      join(plansDir, 'auth-rework/blast-radius-session-store-2026-08-18.md'),
    ]);
  });

  it('finds a root map and the maps of two workspaces together', () => {
    const plansDir = stagePlansDir([
      'blast-radius-config-key-2026-07-02.md',
      'auth-rework/blast-radius-session-store-2026-08-18.md',
      'payments-v2/blast-radius-ledger-2026-09-30.md',
      'payments-v2/phase-1-ledger.md',
    ]);
    expect(listImpactMaps(plansDir, ['auth-rework', 'payments-v2'])).toEqual([
      join(plansDir, 'blast-radius-config-key-2026-07-02.md'),
      join(plansDir, 'auth-rework/blast-radius-session-store-2026-08-18.md'),
      join(plansDir, 'payments-v2/blast-radius-ledger-2026-09-30.md'),
    ]);
  });

  it('returns nothing when the plans directory does not exist', () => {
    const plansDir = join(useRepo('non-js'), '.claude/plans');
    expect(listImpactMaps(plansDir, [])).toEqual([]);
  });
});

describe('checkNoPlanWorkspace', () => {
  it('reports nothing when a workspace exists', () => {
    const report = checkNoPlanWorkspace(['auth-rework']);
    expect(report.findings).toEqual([]);
  });

  it('flags an empty .claude/plans/', () => {
    const report = checkNoPlanWorkspace([]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-lint/no-plan-workspace');
  });
});

describe('checkFencedCodeShare', () => {
  const prose = (count: number) =>
    Array.from({ length: count }, (_, i) => `line ${i}`);
  const fence = (count: number) => [
    '```ts',
    ...Array.from({ length: count }, (_, i) => `code ${i}`),
    '```',
  ];

  it('warns with the count, the total, and the cap on a code-heavy phase', () => {
    const markdown = [...prose(20), ...fence(8)].join('\n');

    const report = checkFencedCodeShare('phase-1.md', markdown);

    expect(markdown.split('\n')).toHaveLength(30);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-lint/fenced-code-share');
    expect(report.findings[0]?.level).toBe('warn');
    expect(report.findings[0]?.msg).toContain('8 of 30');
    expect(report.findings[0]?.msg).toContain('10 percent');
  });

  it('reports nothing on a prose phase with two fenced lines', () => {
    const markdown = [...prose(26), ...fence(2)].join('\n');

    const report = checkFencedCodeShare('phase-1.md', markdown);

    expect(markdown.split('\n')).toHaveLength(30);
    expect(report.findings).toEqual([]);
  });

  it('does not throw on an unclosed fence', () => {
    const markdown = [...prose(5), '```ts', 'code'].join('\n');

    const report = checkFencedCodeShare('phase-1.md', markdown);

    expect(report.findings).toHaveLength(1);
  });
});

describe('checkNotesReplaceStep', () => {
  const phase = (note: string, omitsStandingRulings = false) =>
    [
      '# Phase 1: Demo',
      '',
      ...(omitsStandingRulings ? [] : ['## Standing rulings', '', 'none', '']),
      '## Steps',
      '',
      '- [ ] a step',
      '',
      '## Notes & decisions',
      '',
      note,
    ].join('\n');

  it.each([
    'This replaces Step 3 entirely.',
    'The new flag supersedes step 12.',
    'The old rule no longer applies to STEP 2.',
  ])('warns on a note that says %s', (note) => {
    const report = checkNotesReplaceStep('phase-1.md', phase(note));

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-lint/note-replaces-step');
    expect(report.findings[0]?.level).toBe('warn');
    expect(report.findings[0]?.line).toBe(13);
  });

  it('stays silent on a keyword with no step number', () => {
    const report = checkNotesReplaceStep(
      'phase-1.md',
      phase('This replaces the old parser.'),
    );

    expect(report.findings).toEqual([]);
  });

  it('stays silent on the same words outside the notes section', () => {
    const markdown = [
      '# Phase 1: Demo',
      '',
      '## Steps',
      '',
      '- [ ] this replaces step 3',
      '',
      '## Notes & decisions',
      '',
      'nothing here',
    ].join('\n');

    expect(checkNotesReplaceStep('phase-1.md', markdown).findings).toEqual([]);
  });

  it('stays silent on a keyword inside backticks', () => {
    const report = checkNotesReplaceStep(
      'phase-1.md',
      phase('The text `replaces step 3` is quoted.'),
    );

    expect(report.findings).toEqual([]);
  });

  it('stays silent on a keyword inside a code fence', () => {
    const report = checkNotesReplaceStep(
      'phase-1.md',
      phase('```\nthis replaces step 3\n```'),
    );

    expect(report.findings).toEqual([]);
  });

  it('lints clean on a phase file with no Standing rulings section', () => {
    const report = checkNotesReplaceStep(
      'phase-1.md',
      phase('A plain decision.', true),
    );

    expect(report.findings).toEqual([]);
  });
});

describe('checkReviewFocus', () => {
  const phase = (items: string[]) =>
    [
      '# Phase 1: Demo',
      '',
      '## Steps',
      '',
      '- [ ] a step',
      '',
      '## Review Focus',
      '',
      ...items,
      '',
      '## Notes & decisions',
      '',
      '- unrelated bullet',
    ].join('\n');
  const pinned = (count: number) =>
    Array.from(
      { length: count },
      (_, i) =>
        `- input ${i} is rejected, pinned by \`src/__tests__/case-${i}.test.ts\``,
    );

  it('passes a section with three items that each name a test path', () => {
    const report = checkReviewFocus('phase-1.md', phase(pinned(3)));

    expect(report.findings).toEqual([]);
  });

  it('passes a section at exactly five items', () => {
    const report = checkReviewFocus('phase-1.md', phase(pinned(5)));

    expect(report.findings).toEqual([]);
  });

  it('warns once with the count on a section of six items', () => {
    const report = checkReviewFocus('phase-1.md', phase(pinned(6)));

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-lint/review-focus-count');
    expect(report.findings[0]?.level).toBe('warn');
    expect(report.findings[0]?.msg).toContain('6 items');
  });

  it('warns once, naming the line, on an item with no backticked path', () => {
    const items = [
      ...pinned(2),
      '- an empty config is tolerated',
      ...pinned(1),
    ];

    const report = checkReviewFocus('phase-1.md', phase(items));

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-lint/review-focus-pin');
    expect(report.findings[0]?.line).toBe(11);
    expect(report.findings[0]?.msg).toContain('line 11');
  });

  it('accepts a bare test filename in backticks as the pin', () => {
    const report = checkReviewFocus(
      'phase-1.md',
      phase(['- a stale lock is cleared, pinned by `lock.test.ts`']),
    );

    expect(report.findings).toEqual([]);
  });

  it('reads a path on a wrapped continuation line as part of the item', () => {
    const report = checkReviewFocus(
      'phase-1.md',
      phase([
        '- a stale lock is cleared, pinned by',
        '  `src/__tests__/lock.test.ts`',
      ]),
    );

    expect(report.findings).toEqual([]);
  });

  it('passes a phase with no Review Focus section', () => {
    const report = checkReviewFocus(
      'phase-1.md',
      '# Phase 1: Demo\n\n## Steps\n\n- [ ] a step with no pin\n',
    );

    expect(report.findings).toEqual([]);
  });

  it('passes an empty Review Focus section', () => {
    const report = checkReviewFocus('phase-1.md', phase([]));

    expect(report.findings).toEqual([]);
  });
});

describe('checkPlanPaths', () => {
  const root = repoRootSafe() ?? process.cwd();
  const repoRoots = derivePathRoots(root, null);

  describe('derived roots', () => {
    const tempRoot = () => {
      const dir = mkdtempSync(join(tmpdir(), 'plan-paths-'));
      mkdirSync(join(dir, 'apps/web'), { recursive: true });
      writeFileSync(join(dir, 'apps/web/real.ts'), '');
      writeFileSync(join(dir, 'package.json'), '{}');
      return dir;
    };
    const run = (dir: string, token: string) =>
      checkPlanPaths(
        'p.md',
        `Owns \`${token}\`.\n`,
        dir,
        derivePathRoots(dir, null),
      ).findings;

    it('warns on a missing file under a top-level directory outside the old prefixes', () => {
      const findings = run(tempRoot(), 'apps/web/missing.ts');
      expect(findings.map((finding) => finding.rule)).toEqual([
        'plan-path/missing-file',
      ]);
    });

    it('stays quiet on an existing file under that directory', () => {
      expect(run(tempRoot(), 'apps/web/real.ts')).toEqual([]);
    });

    it('stays quiet when the first segment is no top-level directory', () => {
      expect(run(tempRoot(), 'nowhere/web/missing.ts')).toEqual([]);
    });

    it('stays quiet when the first segment is a top-level file', () => {
      expect(run(tempRoot(), 'package.json/x')).toEqual([]);
    });

    it('stays quiet on a placeholder token with an ellipsis', () => {
      expect(run(tempRoot(), 'apps/…')).toEqual([]);
    });

    it('adds a configured pathPrefix to the roots', () => {
      expect(
        derivePathRoots(tempRoot(), {
          targets: [{ name: 'x', pathPrefix: 'ext' }],
        }),
      ).toContain('ext/');
    });
  });

  it('reports nothing for an existing repo path', () => {
    const report = checkPlanPaths(
      'phase-1.md',
      'Owns `packages/cli/payload/scripts/plan-lint.mts`.\n',
      root,
      repoRoots,
    );
    expect(report.findings).toEqual([]);
  });

  it('flags a path that does not exist in the repo, at its line number', () => {
    const markdown =
      '# Phase 1\n\nOwns `packages/cli/src/does-not-exist.ts`.\n';
    const report = checkPlanPaths('phase-1.md', markdown, root, repoRoots);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-path/missing-file');
    expect(report.findings[0]?.line).toBe(3);
    expect(report.findings[0]?.msg).toContain(
      'packages/cli/src/does-not-exist.ts',
    );
  });

  it('flags a path absent from the repo since the historical failure it was written for', () => {
    const markdown = 'Owns `packages/payload/tsconfig.build.json`.\n';
    const report = checkPlanPaths('phase-1.md', markdown, root, repoRoots);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-path/missing-file');
  });

  it('does not flag a missing path marked "(new)"', () => {
    const markdown = 'Adds `packages/cli/src/does-not-exist.ts` (new).\n';
    const report = checkPlanPaths('phase-1.md', markdown, root, repoRoots);
    expect(report.findings).toEqual([]);
  });

  it('does not flag a glob', () => {
    const markdown = 'Owns `packages/*/payload`.\n';
    const report = checkPlanPaths('phase-1.md', markdown, root, repoRoots);
    expect(report.findings).toEqual([]);
  });

  it('does not flag a missing path inside a fenced code block', () => {
    const markdown = '```\nOwns `packages/cli/src/does-not-exist.ts`.\n```\n';
    const report = checkPlanPaths('phase-1.md', markdown, root, repoRoots);
    expect(report.findings).toEqual([]);
  });

  it.each([':36', ':193-198', ':19,43'])(
    'reports nothing for an existing path with a %s line suffix',
    (suffix) => {
      const markdown = `Owns \`packages/cli/payload/scripts/plan-lint.mts${suffix}\`.\n`;
      const report = checkPlanPaths('phase-1.md', markdown, root, repoRoots);
      expect(report.findings).toEqual([]);
    },
  );

  it('still flags a missing path carrying a line suffix', () => {
    const markdown = 'Owns `packages/cli/src/does-not-exist.ts:36`.\n';
    const report = checkPlanPaths('phase-1.md', markdown, root, repoRoots);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-path/missing-file');
  });
});

const phaseLine = (number: number, after?: string) =>
  `- [ ] **Phase ${number}: part ${number}** · Status: TODO · [sub-plan](phase-${number}.md)${after === undefined ? '' : ` · After: ${after}`}`;

const roadmapOf = (...lines: string[]) => `## Phases\n\n${lines.join('\n')}\n`;

describe('parseRoadmapPhases', () => {
  it('reads number, raw status, sub-plan and the chain default', () => {
    const phases = parseRoadmapPhases(
      `- [x] **Phase 7 — Foo** · Status: DONE (2026-08-18) · [sub-plan](phase-7-foo.md)\n`,
    );
    expect(phases).toEqual([
      {
        number: 7,
        status: 'DONE (2026-08-18)',
        subplan: 'phase-7-foo.md',
        after: 'chain',
      },
    ]);
  });

  it('reads none and number lists with and without spaces', () => {
    const phases = parseRoadmapPhases(
      roadmapOf(
        phaseLine(1, 'none'),
        phaseLine(2, '1,3'),
        phaseLine(3, '1 ,  2'),
        phaseLine(4, '2'),
      ),
    );
    expect(phases.map((phase) => phase.after)).toEqual([
      'none',
      [1, 3],
      [1, 2],
      [2],
    ]);
  });

  it('reads a status that is IN PROGRESS', () => {
    const phases = parseRoadmapPhases(
      '- [ ] **Phase 2: x** · Status: IN PROGRESS · [sub-plan](phase-2.md) · After: none\n',
    );
    expect(phases[0]?.status).toBe('IN PROGRESS');
    expect(phases[0]?.after).toBe('none');
  });

  it('returns nothing for a document without phase lines', () => {
    expect(parseRoadmapPhases('# ROADMAP\n\nNo phases yet.\n')).toEqual([]);
  });
});

describe('parseDomain', () => {
  it('reads comma-separated roots and strips trailing slashes', () => {
    const markdown =
      '**Signals:** none\n**Domain:** `packages/api/`, `packages/shared/src/api-types.ts`,`lib/x//`\n';
    expect(parseDomain(markdown)).toEqual([
      'packages/api',
      'packages/shared/src/api-types.ts',
      'lib/x',
    ]);
  });

  it('drops a trailing (new) after a root', () => {
    expect(parseDomain('**Domain:** `lib/a` (new), `lib/b/` (new)\n')).toEqual([
      'lib/a',
      'lib/b',
    ]);
  });

  it('returns null when the header has no Domain line', () => {
    expect(parseDomain('**Status:** TODO\n**Signals:** none\n')).toBeNull();
  });

  it('keeps a glob character in a root', () => {
    expect(parseDomain('**Domain:** `packages/*/src`\n')).toEqual([
      'packages/*/src',
    ]);
  });
});

describe('parseSignals', () => {
  it('reads comma-separated values, dropping backticks and a trailing note', () => {
    expect(
      parseSignals('**Signals:** `ui`, wide (six packages), live\n'),
    ).toEqual(['ui', 'wide', 'live']);
  });

  it('returns an empty list when the header has no Signals line', () => {
    expect(parseSignals('**Status:** TODO\n**Domain:** `lib/a`\n')).toEqual([]);
  });
});

describe('checkPhaseSchedule', () => {
  const run = (
    markdown: string,
    domains: Record<string, string[] | null>,
    signals: Record<string, string[]> = {},
  ) => checkPhaseSchedule('ROADMAP.md', markdown, domains, signals).findings;

  it.each([
    { signals: { 'phase-3.md': ['ui', 'live'] }, carrier: 'phase 3 carries' },
    {
      signals: { 'phase-2.md': ['live'], 'phase-3.md': ['live'] },
      carrier: 'both carry',
    },
  ])(
    'flags concurrent phases with disjoint domains when $carrier the live signal',
    ({ signals, carrier }) => {
      const findings = run(
        roadmapOf(phaseLine(1), phaseLine(2, '1'), phaseLine(3, '1')),
        { 'phase-1.md': ['a'], 'phase-2.md': ['b'], 'phase-3.md': ['c'] },
        signals,
      );

      expect(findings.map((finding) => finding.msg)).toEqual([
        `phases 2 and 3 can run concurrently, but ${carrier} the live signal`,
      ]);
    },
  );

  it('accepts a live phase that After orders against every other', () => {
    const findings = run(
      roadmapOf(
        phaseLine(1),
        phaseLine(2, '1'),
        phaseLine(3, '1'),
        phaseLine(4, '2,3'),
      ),
      {
        'phase-1.md': ['a'],
        'phase-2.md': ['b'],
        'phase-3.md': ['c'],
        'phase-4.md': ['d'],
      },
      { 'phase-4.md': ['live'] },
    );

    expect(findings).toEqual([]);
  });

  it('reports a live phase that also lacks a domain once, by its signal', () => {
    const findings = run(
      roadmapOf(phaseLine(1), phaseLine(2, '1'), phaseLine(3, '1')),
      { 'phase-1.md': ['a'], 'phase-2.md': ['b'] },
      { 'phase-3.md': ['live'] },
    );

    expect(findings.map((finding) => finding.msg)).toEqual([
      'phases 2 and 3 can run concurrently, but phase 3 carries the live signal',
    ]);
  });

  it('accepts an overlapping concurrent pair when one phase is flat', () => {
    const findings = run(
      roadmapOf(phaseLine(1), phaseLine(2, '1'), phaseLine(3, '1')),
      { 'phase-1.md': ['a'], 'phase-2.md': ['x'], 'phase-3.md': ['x/y'] },
      { 'phase-3.md': ['flat'] },
    );

    expect(findings).toEqual([]);
  });

  it('accepts a domainless flat phase concurrent with another', () => {
    const findings = run(
      roadmapOf(phaseLine(1), phaseLine(2, '1'), phaseLine(3, '1')),
      { 'phase-1.md': ['a'], 'phase-2.md': ['b'], 'phase-3.md': null },
      { 'phase-3.md': ['flat'] },
    );

    expect(findings).toEqual([]);
  });

  it('still reports the live signal on a flat, live phase', () => {
    const findings = run(
      roadmapOf(phaseLine(1), phaseLine(2, '1'), phaseLine(3, '1')),
      { 'phase-1.md': ['a'], 'phase-2.md': ['b'], 'phase-3.md': ['c'] },
      { 'phase-3.md': ['flat', 'live'] },
    );

    expect(findings.map((finding) => finding.msg)).toEqual([
      'phases 2 and 3 can run concurrently, but phase 3 carries the live signal',
    ]);
  });

  it('reports nothing for an unmarked three-phase chain', () => {
    const findings = run(roadmapOf(phaseLine(1), phaseLine(2), phaseLine(3)), {
      'phase-1.md': null,
      'phase-2.md': null,
      'phase-3.md': null,
    });
    expect(findings).toEqual([]);
  });

  it('accepts After none on the first line', () => {
    const findings = run(roadmapOf(phaseLine(1, 'none'), phaseLine(2)), {});
    expect(findings).toEqual([]);
  });

  it('accepts two independent phases with disjoint roots', () => {
    const findings = run(
      roadmapOf(phaseLine(1), phaseLine(2, '1'), phaseLine(3, '1')),
      {
        'phase-1.md': null,
        'phase-2.md': ['packages/api/'],
        'phase-3.md': ['packages/web', 'docs'],
      },
    );
    expect(findings).toEqual([]);
  });

  it('does not let none on a middle line reset the chain below it', () => {
    const findings = run(
      roadmapOf(phaseLine(1), phaseLine(2, 'none'), phaseLine(3)),
      {
        'phase-1.md': ['z'],
        'phase-2.md': ['a'],
        'phase-3.md': ['a/deep'],
      },
    );
    expect(findings).toEqual([]);
  });

  it('flags an After naming a phase not in the ROADMAP', () => {
    const findings = run(roadmapOf(phaseLine(1), phaseLine(2, '9')), {});
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('plan-lint/phase-schedule');
    expect(findings[0]?.level).toBe('error');
    expect(findings[0]?.msg).toContain('phase 2');
    expect(findings[0]?.msg).toContain('phase 9');
  });

  it('flags a word After segment as malformed instead of reading the chain', () => {
    const findings = run(roadmapOf(phaseLine(1), phaseLine(2, 'two')), {
      'phase-1.md': ['a'],
      'phase-2.md': ['a'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('plan-lint/phase-schedule');
    expect(findings[0]?.level).toBe('error');
    expect(findings[0]?.msg).toContain('phase 2');
    expect(findings[0]?.msg).toContain('malformed After');
  });

  it('flags a Domain line with no backticked root, naming the phase', () => {
    const findings = run(roadmapOf(phaseLine(1), phaseLine(2)), {
      'phase-1.md': ['lib/a'],
      'phase-2.md': [],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('plan-lint/phase-schedule');
    expect(findings[0]?.level).toBe('error');
    expect(findings[0]?.msg).toContain('phase 2');
    expect(findings[0]?.msg).toContain('phase-2.md');
    expect(findings[0]?.msg).toContain('no backticked root');
  });

  it('flags an After naming its own phase', () => {
    const findings = run(roadmapOf(phaseLine(1), phaseLine(2, '2')), {});
    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain('phase 2 names itself');
  });

  it('flags After 1,3 on phase 2 when phase 3 chains after 2 as one cycle', () => {
    const findings = run(
      roadmapOf(phaseLine(1), phaseLine(2, '1,3'), phaseLine(3)),
      {},
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain('phases 2, 3 form a cycle');
  });

  it('terminates and reports a longer cycle once', () => {
    const findings = run(
      roadmapOf(
        phaseLine(1, '3'),
        phaseLine(2, '1'),
        phaseLine(3, '2'),
        phaseLine(4, 'none'),
      ),
      {},
    );
    expect(
      findings.filter((finding) => finding.msg.includes('cycle')),
    ).toHaveLength(1);
    expect(findings[0]?.msg).toContain('phases 1, 2, 3');
  });

  it('flags a glob character in a root and names the root', () => {
    const findings = run(roadmapOf(phaseLine(1)), {
      'phase-1.md': ['packages/{a,b}/src'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain('phase 1');
    expect(findings[0]?.msg).toContain('packages/{a,b}/src');
  });

  it.each(['*', '?', '{', '}', '[', ']'])(
    'flags the glob character %s',
    (char) => {
      const findings = run(roadmapOf(phaseLine(1)), {
        'phase-1.md': [`lib/a${char}b`],
      });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.msg).toContain(`lib/a${char}b`);
    },
  );

  it('names the phase that lacks a domain beside a concurrent phase with one', () => {
    const findings = run(
      roadmapOf(phaseLine(1), phaseLine(2, '1'), phaseLine(3, '1')),
      {
        'phase-1.md': ['a'],
        'phase-2.md': ['b'],
        'phase-3.md': null,
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain('phase 3 has no **Domain:**');
  });

  it('names both phases when neither has a domain', () => {
    const findings = run(
      roadmapOf(phaseLine(1), phaseLine(2, '1'), phaseLine(3, '1')),
      { 'phase-1.md': ['a'] },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain('phases 2 and 3');
    expect(findings[0]?.msg).toContain('neither has a **Domain:**');
  });

  it('treats a sub-plan missing from the map as lacking a domain', () => {
    const findings = run(
      roadmapOf(phaseLine(1), phaseLine(2, '1'), phaseLine(3, '1')),
      { 'phase-2.md': ['b'] },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain('phase 3 has no **Domain:**');
  });

  it('names both phases and the root when concurrent roots are equal', () => {
    const findings = run(
      roadmapOf(phaseLine(1), phaseLine(2, '1'), phaseLine(3, '1')),
      {
        'phase-1.md': ['z'],
        'phase-2.md': ['lib/core', 'docs/'],
        'phase-3.md': ['src', 'lib/core/'],
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain('phases 2 and 3');
    expect(findings[0]?.msg).toContain('`lib/core`');
  });

  it('flags packages/api/ against packages/api/src as overlapping', () => {
    const findings = run(
      roadmapOf(
        phaseLine(1, 'none'),
        phaseLine(2, 'none'),
        phaseLine(3, '1,2'),
      ),
      {
        'phase-1.md': ['packages/api/'],
        'phase-2.md': ['packages/api/src'],
        'phase-3.md': null,
      },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.msg).toContain('phases 1 and 2');
    expect(findings[0]?.msg).toContain('packages/api/src');
  });

  it('treats lib/api and lib/api-client as disjoint', () => {
    const findings = run(
      roadmapOf(phaseLine(1, 'none'), phaseLine(2, 'none')),
      { 'phase-1.md': ['lib/api'], 'phase-2.md': ['lib/api-client/'] },
    );
    expect(findings).toEqual([]);
  });

  it('does not compare phases ordered through a transitive After', () => {
    const findings = run(
      roadmapOf(phaseLine(1), phaseLine(2, '1'), phaseLine(3, '2')),
      { 'phase-1.md': ['a'], 'phase-2.md': ['a'], 'phase-3.md': ['a'] },
    );
    expect(findings).toEqual([]);
  });
});

describe('plan-lint.mjs (installed)', () => {
  const SCRIPT = '.claude/scripts/plan-lint.mjs';

  it('installs under the orchestrate module and passes on an empty plans dir', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });
    const result = runScript(root, SCRIPT);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('no plan workspace');
  });

  it('exits 1 naming an argument, since it takes only --gates', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });
    const result = runScript(root, SCRIPT, { args: ['no-such-file-xyz.md'] });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain('no-such-file-xyz.md');
    expect(result.stdout).toContain('checker/unexpected-argument');
    expect(result.stdout).toContain('--gates <milestone-dir> <step>');
  });

  it('exits 1 on a slice status outside the fixed vocabulary', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });
    const planDir = join(root, '.claude/plans/demo');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(
      join(planDir, 'ROADMAP.md'),
      `# ROADMAP — demo

**Status:** IN PROGRESS

## Phases

- [ ] **Phase 1 — Demo** · Status: TODO · [sub-plan](phase-1-demo.md)
`,
    );
    writeFileSync(
      join(planDir, 'phase-1-demo.md'),
      `# Phase 1 — Demo

**Status:** TODO

${SLICE_TABLE('In Progress')}`,
    );
    const result = runScript(root, SCRIPT);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain('plan-lint/slice-status-vocabulary');
  });

  it('exits 1 naming a workspace impact map that lacks its self-audit', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });
    const planDir = join(root, '.claude/plans/demo');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(
      join(planDir, 'blast-radius-auth-2026-08-18.md'),
      `# Blast radius: auth: 2026-08-18

> Snapshot at commit \`abc123\` on 2026-08-18.

## Surface

x

## Impact by file

x

## Cross-package / boundary impact

x
`,
    );
    const result = runScript(root, SCRIPT);
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain('plan-lint/blast-radius-shape');
    expect(result.stdout).toContain(
      '.claude/plans/demo/blast-radius-auth-2026-08-18.md',
    );
  });

  it('does not flag a missing plan-path in a phase doc whose own Status header is DONE', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });
    const planDir = join(root, '.claude/plans/demo');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(
      join(planDir, 'ROADMAP.md'),
      `# ROADMAP — demo

**Status:** IN PROGRESS

## Phases

- [ ] **Phase 1 — Demo** · Status: DONE · [sub-plan](phase-1-demo.md)
`,
    );
    writeFileSync(
      join(planDir, 'phase-1-demo.md'),
      `# Phase 1 — Demo

**Status:** DONE

Owns \`packages/cli/src/does-not-exist.ts\`.
`,
    );
    const result = runScript(root, SCRIPT);
    expect(result.stdout).not.toContain('plan-path/missing-file');
  });

  it('does not flag a missing plan-path anywhere in a workspace whose ROADMAP Status header is DONE', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });
    const planDir = join(root, '.claude/plans/demo');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(
      join(planDir, 'ROADMAP.md'),
      `# ROADMAP — demo

**Status:** DONE

## Phases

- [x] **Phase 1 — Demo** · Status: DONE · [sub-plan](phase-1-demo.md)
`,
    );
    writeFileSync(
      join(planDir, 'phase-1-demo.md'),
      `# Phase 1 — Demo

**Status:** DONE

Owns \`packages/cli/src/does-not-exist.ts\`.
`,
    );
    const result = runScript(root, SCRIPT);
    expect(result.stdout).not.toContain('plan-path/missing-file');
  });

  it('does not flag a missing plan-path anywhere in a workspace whose ROADMAP Status header is SUPERSEDED', () => {
    const root = useInstalledRepo('pnpm-monorepo', { modules: 'orchestrate' });
    const planDir = join(root, '.claude/plans/demo');
    mkdirSync(planDir, { recursive: true });
    writeFileSync(
      join(planDir, 'ROADMAP.md'),
      `# ROADMAP — demo

**Status:** SUPERSEDED

## Phases

- [x] **Phase 1 — Demo** · Status: DONE · [sub-plan](phase-1-demo.md)
`,
    );
    writeFileSync(
      join(planDir, 'phase-1-demo.md'),
      `# Phase 1 — Demo

**Status:** DONE

Owns \`packages/cli/src/does-not-exist.ts\`.
`,
    );
    const result = runScript(root, SCRIPT);
    expect(result.stdout).not.toContain('plan-path/missing-file');
  });

  describe('phase schedule', () => {
    const stage = (
      domain2: string,
      domain3: string,
      after: string,
      signals3 = 'none',
    ) => {
      const root = useInstalledRepo('pnpm-monorepo', {
        modules: 'orchestrate',
      });
      const planDir = join(root, '.claude/plans/demo');
      mkdirSync(planDir, { recursive: true });
      writeFileSync(
        join(planDir, 'ROADMAP.md'),
        `# ROADMAP: demo

**Status:** IN PROGRESS

## Phases

- [ ] **Phase 1: base** · Status: TODO · [sub-plan](phase-1-base.md)
- [ ] **Phase 2: left** · Status: TODO · [sub-plan](phase-2-left.md)${after}
- [ ] **Phase 3: right** · Status: TODO · [sub-plan](phase-3-right.md)${after}
`,
      );
      const phase = (name: string, domain: string, signals = 'none') =>
        writeFileSync(
          join(planDir, name),
          `# Phase\n\n**Status:** TODO\n**Signals:** ${signals}\n${domain}\n`,
        );
      phase('phase-1-base.md', '');
      phase('phase-2-left.md', domain2);
      phase('phase-3-right.md', domain3, signals3);
      return runScript(root, SCRIPT);
    };

    it('exits 1 naming both phases and the shared root when concurrent roots overlap', () => {
      const result = stage(
        '**Domain:** `lib/api/`',
        '**Domain:** `lib/other`, `lib/api/src` (new)',
        ' · After: 1',
      );
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain('plan-lint/phase-schedule');
      expect(result.stdout).toContain('phases 2 and 3');
      expect(result.stdout).toContain('lib/api');
    });

    it('exits 1 on a mixed-list After segment, not reading it as the chain', () => {
      const result = stage(
        '**Domain:** `lib/a`',
        '**Domain:** `lib/b`',
        ' · After: 2,x',
      );
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain('plan-lint/phase-schedule');
      expect(result.stdout).toContain('malformed After');
      expect(result.stdout).toContain('`2,x`');
    });

    it('exits 1 on a Domain line whose root is not in backticks', () => {
      const result = stage(
        '**Domain:** packages/api/',
        '**Domain:** `lib/b`',
        ' · After: 1',
      );
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain('plan-lint/phase-schedule');
      expect(result.stdout).toContain('phase 2');
      expect(result.stdout).toContain('no backticked root');
    });

    it('exits 1 on an empty Domain line', () => {
      const result = stage('**Domain:**', '**Domain:** `lib/b`', ' · After: 1');
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain('no backticked root');
    });

    it('exits 1 naming the live phase when it can run beside another', () => {
      const result = stage(
        '**Domain:** `lib/a`',
        '**Domain:** `lib/b`',
        ' · After: 1',
        'live',
      );
      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain('phase 3 carries the live signal');
    });

    it('exits 0 when the concurrent roots are disjoint', () => {
      const result = stage(
        '**Domain:** `lib/api`',
        '**Domain:** `lib/api-client`',
        ' · After: 1',
      );
      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).not.toContain('plan-lint/phase-schedule');
    });

    it('exits 0 with no markers, whatever the domains say', () => {
      const result = stage(
        '**Domain:** `lib/api`',
        '**Domain:** `lib/api`',
        '',
      );
      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).not.toContain('plan-lint/phase-schedule');
    });
  });

  describe('milestones', () => {
    const milestoneFile = (
      status: string,
      memberRows: string,
    ) => `# MILESTONE: launch

**Status:** ${status} · **Started:** 2026-11-01 · **Updated:** 2026-11-19

## Members

| Member | Owns | Verify |
| --- | --- | --- |
${memberRows}

## Held paths

- \`pnpm-lock.yaml\`

## Steps

### Step: first · Status: TODO

Both surfaces render.

- Items: \`api/routes\`,
  \`web/pages\`
- Close: \`pnpm check\`
- Needs: none

## Log

- 2026-11-19: scaffolded. Bar: two members share a contract.
`;
    const API_ROW = '| `api` | the API | `pnpm --filter api check` |';
    const WEB_ROW = '|`web`|the web app|`pnpm --filter web check`|';

    const memberRoadmap = (slug: string, phaseStatus: string) =>
      `# ROADMAP: ${slug}\n\n**Status:** IN PROGRESS\n\n## Phases\n\n- [ ] **Phase 1: ${slug}** · Status: ${phaseStatus} · [sub-plan](phase-1-${slug}.md)\n`;
    const memberPhase = (status: string, domain: string, body: string) =>
      `# Phase 1\n\n**Status:** ${status}\n**Domain:** \`${domain}\`\n**Signals:** none\n\n${body}\n`;

    const cleanMilestone = (): Record<string, string> => ({
      'launch/MILESTONE.md': milestoneFile(
        'IN PROGRESS',
        `${API_ROW}\n${WEB_ROW}`,
      ),
      'launch/api/ROADMAP.md': memberRoadmap('routes', 'TODO'),
      'launch/api/phase-1-routes.md': memberPhase('TODO', 'lib/api', ''),
      'launch/web/ROADMAP.md': memberRoadmap('pages', 'TODO'),
      'launch/web/phase-1-pages.md': memberPhase('TODO', 'lib/web/', ''),
    });
    const BAD_SLICE_PHASE = `# Phase 1\n\n**Status:** TODO\n\n${SLICE_TABLE('In Progress')}`;

    const runOver = (files: Record<string, string>, args: string[] = []) => {
      const root = useInstalledRepo('pnpm-monorepo', {
        modules: 'orchestrate',
      });
      for (const [path, content] of Object.entries(files)) {
        const filePath = join(root, '.claude/plans', path);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, content);
      }
      return runScript(root, SCRIPT, { args });
    };

    it('exits 0 with no milestone finding on two members in one step with disjoint domains', () => {
      const result = runOver(cleanMilestone());

      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).not.toContain('[milestone/');
    });

    it('reports a nested member whose ROADMAP and sub-plan disagree, by its repo-relative path', () => {
      const result = runOver({
        ...cleanMilestone(),
        'launch/web/phase-1-pages.md': memberPhase(
          'IN PROGRESS',
          'lib/web',
          '',
        ),
      });

      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain(
        '.claude/plans/launch/web/ROADMAP.md  ERROR  [plan-lint/roadmap-subplan-sync]',
      );
    });

    it('exits 1 naming MILESTONE.md when two items in one step share a Domain root', () => {
      const result = runOver({
        ...cleanMilestone(),
        'launch/web/phase-1-pages.md': memberPhase('TODO', 'lib/api/pages', ''),
      });

      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain(
        '.claude/plans/launch/MILESTONE.md:18  ERROR  [milestone/item-domain-overlap]',
      );
    });

    it('errors on a milestone directory that also holds ROADMAP.md', () => {
      const result = runOver({
        ...cleanMilestone(),
        'launch/ROADMAP.md': memberRoadmap('stray', 'TODO'),
      });

      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain(
        '.claude/plans/launch/ROADMAP.md  ERROR  [milestone/has-roadmap]',
      );
    });

    it('never lints the milestone directory itself as a plan', () => {
      const result = runOver({
        ...cleanMilestone(),
        'launch/ROADMAP.md': memberRoadmap('stray', 'TODO'),
        'launch/phase-1-stray.md': BAD_SLICE_PHASE,
      });

      expect(result.stdout).not.toContain('plan-lint/slice-status-vocabulary');
    });

    it('errors on a table member with no directory, naming the ROADMAP it expected', () => {
      const result = runOver({
        ...cleanMilestone(),
        'launch/MILESTONE.md': milestoneFile(
          'IN PROGRESS',
          `${API_ROW}\n${WEB_ROW}\n|  \`mobile\`  |  the app  |  \`pnpm test\`  |`,
        ),
      });

      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain(
        '[milestone/member-missing]  member `mobile` is in the ## Members table, but .claude/plans/launch/mobile/ROADMAP.md does not exist',
      );
    });

    it('errors on a member directory missing from the table', () => {
      const result = runOver({
        ...cleanMilestone(),
        'launch/MILESTONE.md': milestoneFile('IN PROGRESS', API_ROW),
      });

      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain(
        '[milestone/member-unlisted]  .claude/plans/launch/web holds ROADMAP.md',
      );
    });

    it('still lints a member directory missing from the table as a plan', () => {
      const result = runOver({
        ...cleanMilestone(),
        'launch/docs/ROADMAP.md': memberRoadmap('guide', 'TODO'),
        'launch/docs/phase-1-guide.md': BAD_SLICE_PHASE,
      });

      expect(result.stdout).toMatch(
        /\.claude\/plans\/launch\/docs\/phase-1-guide\.md\S*\s+ERROR\s+\[plan-lint\/slice-status-vocabulary\]/,
      );
    });

    it('skips a milestone subdirectory with no ROADMAP.md', () => {
      const result = runOver({
        ...cleanMilestone(),
        'launch/research/SYNTHESIS.md': '# Synthesis\n',
        'launch/research/phase-1-notes.md': BAD_SLICE_PHASE,
      });

      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).not.toContain('research');
    });

    it("never reads a member's own subdirectories", () => {
      const result = runOver({
        ...cleanMilestone(),
        'launch/api/old/ROADMAP.md': memberRoadmap('legacy', 'DONE'),
        'launch/api/old/phase-1-legacy.md': BAD_SLICE_PHASE,
      });

      expect(result.status, result.stdout).toBe(0);
      expect(result.stdout).not.toContain('launch/api/old');
    });

    it('checks member paths while the milestone is IN PROGRESS', () => {
      const result = runOver({
        ...cleanMilestone(),
        'launch/api/phase-1-routes.md': memberPhase(
          'TODO',
          'lib/api',
          'Owns `packages/cli/src/does-not-exist.ts`.',
        ),
      });

      expect(result.stdout).toContain(
        '.claude/plans/launch/api/phase-1-routes.md:7  WARN  [plan-path/missing-file]',
      );
    });

    it('skips member path checks once the milestone is DONE', () => {
      const result = runOver({
        ...cleanMilestone(),
        'launch/MILESTONE.md': milestoneFile(
          'DONE (2026-11-19)',
          `${API_ROW}\n${WEB_ROW}`,
        ),
        'launch/api/phase-1-routes.md': memberPhase(
          'TODO',
          'lib/api',
          'Owns `packages/cli/src/does-not-exist.ts`.',
        ),
      });

      expect(result.stdout).not.toContain('plan-path/missing-file');
    });

    it('reads an impact map in a member directory', () => {
      const result = runOver({
        ...cleanMilestone(),
        'launch/api/blast-radius-auth-2026-11-19.md':
          '# Blast radius: auth\n\n## Surface\n\nx\n',
      });

      expect(result.stdout).toContain(
        '.claude/plans/launch/api/blast-radius-auth-2026-11-19.md',
      );
    });

    it('refuses an argument with a clean milestone present', () => {
      const result = runOver(cleanMilestone(), ['launch/MILESTONE.md']);

      expect(result.status, result.stdout).toBe(1);
      expect(result.stdout).toContain(
        'launch/MILESTONE.md  ERROR  [checker/unexpected-argument]',
      );
      expect(result.stdout).toContain('--gates <milestone-dir> <step>');
    });

    it('prints the gate line blocking a step with --gates', () => {
      const withGate = milestoneFile(
        'IN PROGRESS',
        `${API_ROW}\n${WEB_ROW}`,
      ).replace(
        '## Steps',
        '## Gates\n\n- G1 · OPEN · decision · auth · blocks `first`\n\n## Steps',
      );
      const result = runOver({ 'launch/MILESTONE.md': withGate }, [
        '--gates',
        '.claude/plans/launch',
        'first',
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('G1 · OPEN · blocks first\n');
    });

    it('exits nonzero naming the path when --gates finds no milestone', () => {
      const result = runOver({}, ['--gates', '.claude/plans/nope', 'first']);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('.claude/plans/nope/MILESTONE.md');
    });
  });
});

describe('DROPPED phases', () => {
  const droppedPhaseLine = (phaseNumber: number, afterTarget: string | null) =>
    `- [-] **Phase ${phaseNumber}: part ${phaseNumber}** · Status: DROPPED (2026-11-19, moved to phase 3) · [sub-plan](phase-${phaseNumber}.md)${afterTarget === null ? '' : ` · After: ${afterTarget}`}`;
  const run = (markdown: string, domains: Record<string, string[] | null>) =>
    checkPhaseSchedule('ROADMAP.md', markdown, domains, {}).findings;

  it('parses a [-] line with its DROPPED status', () => {
    expect(
      parseRoadmapPhases(
        '- [-] **Phase 2: x** · Status: DROPPED (2026-11-19, moved to phase 3) · [sub-plan](phase-2-x.md)\n',
      ),
    ).toEqual([
      {
        number: 2,
        status: 'DROPPED (2026-11-19, moved to phase 3)',
        subplan: 'phase-2-x.md',
        after: 'chain',
      },
    ]);
  });

  it('accepts DROPPED on both sides of the roadmap sync', () => {
    const roadmap = `${droppedPhaseLine(2, null)}\n`;
    expect(
      checkRoadmapSync('ROADMAP.md', roadmap, {
        'phase-2.md': 'DROPPED (2026-11-19, cut)',
      }).findings,
    ).toEqual([]);
    expect(
      checkRoadmapSync('ROADMAP.md', roadmap, { 'phase-2.md': 'TODO' })
        .findings,
    ).toHaveLength(1);
  });

  it('reports no pair error for a dropped phase with no Domain', () => {
    const markdown = roadmapOf(
      phaseLine(1),
      droppedPhaseLine(2, '1'),
      phaseLine(3, '1'),
    );
    expect(run(markdown, { 'phase-1.md': ['a'], 'phase-3.md': ['c'] })).toEqual(
      [],
    );
  });

  it('still reports the pair when that phase is TODO', () => {
    const markdown = roadmapOf(
      phaseLine(1),
      phaseLine(2, '1'),
      phaseLine(3, '1'),
    );
    expect(
      run(markdown, { 'phase-1.md': ['a'], 'phase-3.md': ['c'] }).map(
        (finding) => finding.msg,
      ),
    ).toEqual([
      'phases 2 and 3 can run concurrently, but phase 2 has no **Domain:** line',
    ]);
  });

  it('keeps a dropped phase a valid After target with ancestry through it', () => {
    const markdown = roadmapOf(
      phaseLine(1),
      droppedPhaseLine(2, '1'),
      phaseLine(3, '2'),
      phaseLine(4, '1'),
    );
    const findings = run(markdown, {
      'phase-1.md': ['a'],
      'phase-3.md': ['x'],
      'phase-4.md': ['x'],
    });
    expect(findings.map((finding) => finding.msg)).toEqual([
      expect.stringContaining('phases 3 and 4 can run concurrently'),
    ]);
  });
});

describe('checkSignals', () => {
  it('accepts owner and the other known signals', () => {
    expect(
      checkSignals('p.md', '**Signals:** owner, `ui`, wide, live\n').findings,
    ).toEqual([]);
  });

  it('warns once on an unknown signal and names it', () => {
    const findings = checkSignals('p.md', '**Signals:** wdie, ui\n').findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('plan-lint/unknown-signal');
    expect(findings[0]?.level).toBe('warn');
    expect(findings[0]?.msg).toContain('wdie');
  });

  it('reads none as no signal', () => {
    expect(checkSignals('p.md', '**Signals:** none\n').findings).toEqual([]);
  });

  it('accepts flat', () => {
    expect(checkSignals('p.md', '**Signals:** flat\n').findings).toEqual([]);
  });

  it('lists flat among the valid signals in the unknown-signal message', () => {
    const findings = checkSignals('p.md', '**Signals:** wdie\n').findings;
    expect(findings[0]?.msg).toBe(
      'unknown signal `wdie`, use wide, ui, live, owner, flat, or none',
    );
  });
});

describe('checkBudget', () => {
  it.each([
    '**Budget:** 900 lines, 70 files\n',
    '# Phase\n\n**Status:** TODO\n',
  ])('finds nothing on a valid or absent line', (markdown) => {
    expect(checkBudget('p.md', markdown).findings).toEqual([]);
  });

  it.each(['0 lines, 50 files', '600 lines', '600 lines, 0 files', 'big'])(
    'warns once on `%s`',
    (value) => {
      const findings = checkBudget('p.md', `**Budget:** ${value}\n`).findings;
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe('plan-lint/malformed-budget');
      expect(findings[0]?.level).toBe('warn');
    },
  );
});

describe('checkWorkspacePhaseFlat', () => {
  const run = (header: string) =>
    checkWorkspacePhaseFlat('phase-2-x.md', `# Phase\n\n${header}\n`).findings;

  it.each([
    '**Domain:** `.claude/plans/demo`',
    '**Domain:** `.claude/plans`',
    '**Domain:** `.claude/plans/demo/`, `.claude/plans/other (new)`',
  ])('warns naming the sub-plan and the flat signal for %s', (header) => {
    const findings = run(header);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('plan-lint/workspace-phase-not-flat');
    expect(findings[0]?.level).toBe('warn');
    expect(findings[0]?.msg).toContain('phase-2-x.md');
    expect(findings[0]?.msg).toContain('`flat`');
  });

  it.each([
    '**Signals:** flat\n**Domain:** `.claude/plans/demo`',
    '**Domain:** `.claude/plans/demo`, `packages/cli`',
    '**Signals:** ui\n**Domain:** `packages/cli`',
    '**Domain:** `.claude/plans-old/x`',
    '# no domain here',
    '**Domain:** no backticks',
  ])('stays silent for %s', (header) => {
    expect(run(header)).toEqual([]);
  });

  describe('through the script', () => {
    const SCRIPT = '.claude/scripts/plan-lint.mjs';
    const stage = (status: string) => {
      const root = useInstalledRepo('pnpm-monorepo', {
        modules: 'orchestrate',
      });
      const planDir = join(root, '.claude/plans/demo');
      mkdirSync(planDir, { recursive: true });
      writeFileSync(
        join(planDir, 'ROADMAP.md'),
        `# ROADMAP: demo\n\n**Status:** IN PROGRESS\n\n## Phases\n\n- [ ] **Phase 1: only** · Status: ${status} · [sub-plan](phase-1-only.md)\n`,
      );
      writeFileSync(
        join(planDir, 'phase-1-only.md'),
        `# Phase\n\n**Status:** ${status}\n**Domain:** \`.claude/plans/demo\`\n`,
      );
      return runScript(root, SCRIPT);
    };

    it.each(['TODO', 'IN PROGRESS'])('warns on a %s phase', (status) => {
      expect(stage(status).stdout).toContain(
        'plan-lint/workspace-phase-not-flat',
      );
    });

    it.each(['DONE', 'DROPPED'])('stays silent on a %s phase', (status) => {
      expect(stage(status).stdout).not.toContain(
        'plan-lint/workspace-phase-not-flat',
      );
    });
  });
});
