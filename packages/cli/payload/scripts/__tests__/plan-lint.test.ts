import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  checkBlastRadiusShape,
  checkFencedCodeShare,
  checkFixOnSubagentStop,
  checkNoPlanWorkspace,
  checkPhaseSchedule,
  checkPlanPaths,
  checkReviewFocus,
  checkRoadmapSync,
  checkSliceStatuses,
  parseDomain,
  parseRoadmapPhases,
} from '../plan-lint.mjs';

import { repoRootSafe } from '@houserules/payload/config';
import { useInstalledRepo } from '#test/repo';
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

  it('reports nothing for an existing repo path', () => {
    const report = checkPlanPaths(
      'phase-1.md',
      'Owns `packages/cli/payload/scripts/plan-lint.mts`.\n',
      root,
    );
    expect(report.findings).toEqual([]);
  });

  it('flags a path that does not exist in the repo, at its line number', () => {
    const markdown =
      '# Phase 1\n\nOwns `packages/cli/src/does-not-exist.ts`.\n';
    const report = checkPlanPaths('phase-1.md', markdown, root);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-path/missing-file');
    expect(report.findings[0]?.line).toBe(3);
    expect(report.findings[0]?.msg).toContain(
      'packages/cli/src/does-not-exist.ts',
    );
  });

  it('flags a path absent from the repo since the historical failure it was written for', () => {
    const markdown = 'Owns `packages/payload/tsconfig.build.json`.\n';
    const report = checkPlanPaths('phase-1.md', markdown, root);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.rule).toBe('plan-path/missing-file');
  });

  it('does not flag a missing path marked "(new)"', () => {
    const markdown = 'Adds `packages/cli/src/does-not-exist.ts` (new).\n';
    const report = checkPlanPaths('phase-1.md', markdown, root);
    expect(report.findings).toEqual([]);
  });

  it('does not flag a glob', () => {
    const markdown = 'Owns `packages/*/payload`.\n';
    const report = checkPlanPaths('phase-1.md', markdown, root);
    expect(report.findings).toEqual([]);
  });

  it('does not flag a missing path inside a fenced code block', () => {
    const markdown = '```\nOwns `packages/cli/src/does-not-exist.ts`.\n```\n';
    const report = checkPlanPaths('phase-1.md', markdown, root);
    expect(report.findings).toEqual([]);
  });

  it.each([':36', ':193-198', ':19,43'])(
    'reports nothing for an existing path with a %s line suffix',
    (suffix) => {
      const markdown = `Owns \`packages/cli/payload/scripts/plan-lint.mts${suffix}\`.\n`;
      const report = checkPlanPaths('phase-1.md', markdown, root);
      expect(report.findings).toEqual([]);
    },
  );

  it('still flags a missing path carrying a line suffix', () => {
    const markdown = 'Owns `packages/cli/src/does-not-exist.ts:36`.\n';
    const report = checkPlanPaths('phase-1.md', markdown, root);
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

describe('checkPhaseSchedule', () => {
  const run = (markdown: string, domains: Record<string, string[] | null>) =>
    checkPhaseSchedule('ROADMAP.md', markdown, domains).findings;

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
    const stage = (domain2: string, domain3: string, after: string) => {
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
      const phase = (name: string, domain: string) =>
        writeFileSync(
          join(planDir, name),
          `# Phase\n\n**Status:** TODO\n**Signals:** none\n${domain}\n`,
        );
      phase('phase-1-base.md', '');
      phase('phase-2-left.md', domain2);
      phase('phase-3-right.md', domain3);
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
});
