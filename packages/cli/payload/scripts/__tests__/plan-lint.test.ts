import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  checkBlastRadiusShape,
  checkFencedCodeShare,
  checkFixOnSubagentStop,
  checkNoPlanWorkspace,
  checkPlanPaths,
  checkReviewFocus,
  checkRoadmapSync,
  checkSliceStatuses,
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
});
