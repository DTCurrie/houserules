import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const SCRIPT = '.claude/scripts/plan-state.mjs';

function put(root: string, rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function installedRepo(): string {
  return useInstalledRepo('pnpm-monorepo', { modules: 'plans' });
}

function show(root: string, workspace: string) {
  return runScript(root, SCRIPT, { args: ['show', workspace, '--json'] });
}

const roadmapLine = (n: number, slug: string, status: string) =>
  `- **Phase ${n} · ${slug}** · Status: ${status} · [sub-plan](phase-${n}-${slug}.md)`;

const subplan = (status: string, table = '') =>
  `# Phase\n\n**Status:** ${status}\n\n${table}`;

const TABLE = `## Slices

| id | owns | depends | wave | status |
| -- | ---- | ------- | ---- | ------ |
| 1a | \`src/a.ts\` | — | 1 | DONE |
| 1b | \`src/b.ts\` | 1a | 2 | TODO |
`;

describe('plan-state show --json', () => {
  it('reports the whole object for a two-phase plan', () => {
    const root = installedRepo();
    const dir = '.claude/plans/demo';
    put(
      root,
      `${dir}/ROADMAP.md`,
      `# Roadmap\n\n${roadmapLine(1, 'alpha', 'DONE')}\n${roadmapLine(2, 'beta', 'TODO')}\n`,
    );
    put(root, `${dir}/phase-1-alpha.md`, subplan('DONE', TABLE));
    put(root, `${dir}/phase-2-beta.md`, subplan('TODO'));

    const result = show(root, dir);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      workspace: '.claude/plans/demo',
      kind: 'plan',
      phases: [
        {
          number: 1,
          slug: 'alpha',
          roadmapStatus: 'DONE',
          headerStatus: 'DONE',
          mismatch: false,
          slices: [
            {
              id: '1a',
              owns: '`src/a.ts`',
              depends: '—',
              wave: '1',
              status: 'DONE',
            },
            {
              id: '1b',
              owns: '`src/b.ts`',
              depends: '1a',
              wave: '2',
              status: 'TODO',
            },
          ],
        },
        {
          number: 2,
          slug: 'beta',
          roadmapStatus: 'TODO',
          headerStatus: 'TODO',
          mismatch: false,
          slices: [],
        },
      ],
    });
  });

  it('returns no slices for a sub-plan without a Slices table', () => {
    const root = installedRepo();
    put(root, 'p/ROADMAP.md', `${roadmapLine(1, 'solo', 'TODO')}\n`);
    put(root, 'p/phase-1-solo.md', subplan('TODO'));

    const state = JSON.parse(show(root, 'p').stdout);

    expect(state.phases[0].slices).toEqual([]);
  });

  it('trims space-padded cells and finds columns by name in any order', () => {
    const root = installedRepo();
    put(root, 'p/ROADMAP.md', `${roadmapLine(1, 'solo', 'TODO')}\n`);
    put(
      root,
      'p/phase-1-solo.md',
      subplan(
        'TODO',
        '## Slices\n\n|   Status   |  ID  |   Owns   |\n| - | - | - |\n|   TODO    |   9z   |   `x/**`   |\n',
      ),
    );

    const state = JSON.parse(show(root, 'p').stdout);

    expect(state.phases[0].slices).toEqual([
      { id: '9z', owns: '`x/**`', depends: '', wave: '', status: 'TODO' },
    ]);
  });

  it('reports kind member when the parent directory holds MILESTONE.md', () => {
    const root = installedRepo();
    put(root, 'ms/MILESTONE.md', '# Milestone\n');
    put(root, 'ms/member/ROADMAP.md', `${roadmapLine(1, 'solo', 'TODO')}\n`);

    const state = JSON.parse(show(root, 'ms/member').stdout);

    expect(state.kind).toBe('member');
  });

  it('flags a mismatch between ROADMAP and header and still exits 0', () => {
    const root = installedRepo();
    put(root, 'p/ROADMAP.md', `${roadmapLine(1, 'solo', 'DONE')}\n`);
    put(root, 'p/phase-1-solo.md', subplan('DISPATCHED'));

    const result = show(root, 'p');

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).phases[0]).toMatchObject({
      roadmapStatus: 'DONE',
      headerStatus: 'DISPATCHED',
      mismatch: true,
    });
  });

  it('reports headerStatus null and no mismatch when the sub-plan is absent', () => {
    const root = installedRepo();
    put(root, 'p/ROADMAP.md', `${roadmapLine(1, 'solo', 'TODO')}\n`);

    const state = JSON.parse(show(root, 'p').stdout);

    expect(state.phases[0]).toMatchObject({
      headerStatus: null,
      mismatch: false,
      slices: [],
    });
  });
});

describe('plan-state show without --json', () => {
  it('flags a mismatched phase in the text table', () => {
    const root = installedRepo();
    put(root, 'p/ROADMAP.md', `${roadmapLine(1, 'solo', 'DONE')}\n`);
    put(root, 'p/phase-1-solo.md', subplan('TODO'));

    const result = runScript(root, SCRIPT, { args: ['show', 'p'] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('MISMATCH');
  });
});

describe('plan-state errors', () => {
  it('exits 1 naming the path when the workspace is missing', () => {
    const root = installedRepo();

    const result = show(root, 'no/such/plan');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no/such/plan');
  });

  it('exits 1 naming the path when the ROADMAP has no phase lines', () => {
    const root = installedRepo();
    put(root, 'p/ROADMAP.md', '# Roadmap\n\nnothing here\n');

    const result = show(root, 'p');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(join(root, 'p', 'ROADMAP.md'));
  });

  it('exits 2 with a usage line when given no arguments', () => {
    const result = runScript(installedRepo(), SCRIPT);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: plan-state.mjs show');
  });
});

describe('plans module install', () => {
  it('installs the script and its parser lib, and the script runs from the repo', () => {
    const root = installedRepo();
    put(
      root,
      '.claude/plans/x/ROADMAP.md',
      `${roadmapLine(1, 'solo', 'TODO')}\n`,
    );

    const result = show(root, '.claude/plans/x');

    expect(existsSync(join(root, '.claude/scripts/plan-state.mjs'))).toBe(true);
    expect(
      existsSync(join(root, '.claude/scripts/lib/plan-markdown.mjs')),
    ).toBe(true);
    expect(result.status).toBe(0);
  });
});

const PLAN_DIR = '.claude/plans/demo';

function todayLocal(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function set(root: string, ...args: string[]) {
  return runScript(root, SCRIPT, { args: ['set', ...args] });
}

const ROADMAP = `# ROADMAP: demo

**Status:** IN PROGRESS · **Started:** 2026-01-01 · **Updated:** 2026-01-02

## Phases

- [ ] **Phase 1: Alpha** · Status: TODO · [sub-plan](phase-1-alpha.md) · After: none
- [ ] **Phase 2: Beta** · Status: TODO · [sub-plan](phase-2-beta.md)

## Log

- 2026-01-02: started
- 2026-01-02: second line

## Appendix

kept
`;

const PADDED_TABLE = `## Slices

| id  | owns      | depends | wave | status      |
| --- | --------- | ------- | ---- | ----------- |
| 1a  | \`src/a.ts\` | none    | 1    | TODO        |
| 1b  | \`src/b.ts\` | 1a      | 2    | TODO        |
`;

const UNPADDED_TABLE = `## Slices

|id|owns|depends|wave|status|
|--|--|--|--|--|
|1a|\`src/a.ts\`|none|1|TODO|
|1b|\`src/b.ts\`|1a|2|TODO|
`;

const SUBPLAN_HEADER = '**Status:** TODO · **Part of:** [PLAN.md](PLAN.md)';

function alpha(table = PADDED_TABLE, header = SUBPLAN_HEADER): string {
  return `# Phase 1: alpha\n\n${header}\n\nbody text\n\n${table}`;
}

function stagePlan(
  root: string,
  files: { roadmap?: string; alpha?: string } = {},
): void {
  put(root, `${PLAN_DIR}/ROADMAP.md`, files.roadmap ?? ROADMAP);
  put(root, `${PLAN_DIR}/phase-1-alpha.md`, files.alpha ?? alpha());
  put(root, `${PLAN_DIR}/phase-2-beta.md`, subplan('TODO'));
}

function snapshot(root: string): string[] {
  return [
    read(root, `${PLAN_DIR}/ROADMAP.md`),
    read(root, `${PLAN_DIR}/phase-1-alpha.md`),
    read(root, `${PLAN_DIR}/phase-2-beta.md`),
  ];
}

describe('plan-state set, addressing a phase', () => {
  it('writes identical bytes whether the phase is named by number or by slug', () => {
    const byNumber = installedRepo();
    const bySlug = installedRepo();
    stagePlan(byNumber);
    stagePlan(bySlug);

    const first = set(byNumber, PLAN_DIR, '1', 'DONE');
    const second = set(bySlug, PLAN_DIR, 'alpha', 'DONE');

    expect([first.status, second.status]).toEqual([0, 0]);
    expect(snapshot(byNumber)).toEqual(snapshot(bySlug));
    expect(read(byNumber, `${PLAN_DIR}/ROADMAP.md`)).toContain(
      `Status: DONE (${todayLocal()}) · [sub-plan](phase-1-alpha.md)`,
    );
  });

  it('exits 1 and writes nothing for a slug that matches no phase', () => {
    const root = installedRepo();
    stagePlan(root);
    const before = snapshot(root);

    const result = set(root, PLAN_DIR, 'gamma', 'DONE');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gamma');
    expect(snapshot(root)).toEqual(before);
  });

  it('exits 1 and writes nothing for a phase number that matches no phase', () => {
    const root = installedRepo();
    stagePlan(root);
    const before = snapshot(root);

    const result = set(root, PLAN_DIR, '9', 'DONE');

    expect(result.status).toBe(1);
    expect(snapshot(root)).toEqual(before);
  });
});

describe('plan-state set, status vocabularies', () => {
  it('refuses DISPATCHED for a phase with exit 2 naming the list, writing nothing', () => {
    const root = installedRepo();
    stagePlan(root);
    const before = snapshot(root);

    const result = set(root, PLAN_DIR, '1', 'DISPATCHED');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'TODO, IN PROGRESS, DONE, DROPPED, BLOCKED',
    );
    expect(snapshot(root)).toEqual(before);
  });

  it('accepts DISPATCHED for a slice', () => {
    const root = installedRepo();
    stagePlan(root);

    const result = set(root, PLAN_DIR, '1', '--slice', '1a', 'DISPATCHED');

    expect(result.status).toBe(0);
    expect(read(root, `${PLAN_DIR}/phase-1-alpha.md`)).toContain(
      '| 1a  | `src/a.ts` | none    | 1    | DISPATCHED  |',
    );
  });

  it('refuses DROPPED for a slice with exit 2, writing nothing', () => {
    const root = installedRepo();
    stagePlan(root);
    const before = snapshot(root);

    const result = set(root, PLAN_DIR, '1', '--slice', '1a', 'DROPPED');

    expect(result.status).toBe(2);
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses a lowercase status with exit 2, writing nothing', () => {
    const root = installedRepo();
    stagePlan(root);
    const before = snapshot(root);

    const result = set(root, PLAN_DIR, '1', 'done');

    expect(result.status).toBe(2);
    expect(snapshot(root)).toEqual(before);
  });
});

describe('plan-state set, a phase status', () => {
  const today = todayLocal();

  it.each([
    {
      status: 'TODO',
      box: ' ',
      cell: 'TODO',
    },
    {
      status: 'IN PROGRESS',
      box: '~',
      cell: 'IN PROGRESS',
    },
    {
      status: 'BLOCKED',
      box: '~',
      cell: 'BLOCKED',
    },
    {
      status: 'DONE',
      box: 'x',
      cell: `DONE (${today})`,
    },
    {
      status: 'DROPPED',
      box: 'x',
      cell: `DROPPED (${today})`,
    },
  ])(
    'writes $status as checkbox [$box] and the exact bytes of both files',
    ({ status, box, cell }) => {
      const root = installedRepo();
      stagePlan(root);

      const result = set(root, PLAN_DIR, '1', status);

      expect(result.status).toBe(0);
      expect(read(root, `${PLAN_DIR}/ROADMAP.md`)).toBe(`# ROADMAP: demo

**Status:** IN PROGRESS · **Started:** 2026-01-01 · **Updated:** ${today}

## Phases

- [${box}] **Phase 1: Alpha** · Status: ${cell} · [sub-plan](phase-1-alpha.md) · After: none
- [ ] **Phase 2: Beta** · Status: TODO · [sub-plan](phase-2-beta.md)

## Log

- 2026-01-02: started
- 2026-01-02: second line

## Appendix

kept
`);
      expect(read(root, `${PLAN_DIR}/phase-1-alpha.md`)).toBe(
        alpha(
          PADDED_TABLE,
          `**Status:** ${cell} · **Part of:** [PLAN.md](PLAN.md)`,
        ),
      );
      expect(read(root, `${PLAN_DIR}/phase-2-beta.md`)).toBe(subplan('TODO'));
    },
  );

  it('replaces a parenthetical already on the ROADMAP cell and the header', () => {
    const root = installedRepo();
    stagePlan(root, {
      roadmap: ROADMAP.replace(
        'Status: TODO · [sub-plan](phase-1',
        'Status: DONE (2020-01-01) · [sub-plan](phase-1',
      ).replace('- [ ] **Phase 1', '- [x] **Phase 1'),
      alpha: alpha(
        PADDED_TABLE,
        '**Status:** DONE (2020-01-01) · **Part of:** [PLAN.md](PLAN.md)',
      ),
    });

    const result = set(root, PLAN_DIR, '1', 'IN PROGRESS');

    expect(result.status).toBe(0);
    expect(read(root, `${PLAN_DIR}/ROADMAP.md`)).toContain(
      '- [~] **Phase 1: Alpha** · Status: IN PROGRESS · [sub-plan](phase-1-alpha.md) · After: none',
    );
    expect(read(root, `${PLAN_DIR}/phase-1-alpha.md`)).toContain(
      '**Status:** IN PROGRESS · **Part of:**',
    );
  });

  it('rewrites a sub-plan header that has no separator through the end of the line', () => {
    const root = installedRepo();
    stagePlan(root, { alpha: alpha(PADDED_TABLE, '**Status:** TODO') });

    const result = set(root, PLAN_DIR, '1', 'IN PROGRESS');

    expect(result.status).toBe(0);
    expect(read(root, `${PLAN_DIR}/phase-1-alpha.md`)).toBe(
      alpha(PADDED_TABLE, '**Status:** IN PROGRESS'),
    );
  });

  it('writes the second phase line and leaves the first line alone', () => {
    const root = installedRepo();
    stagePlan(root);

    const result = set(root, PLAN_DIR, 'beta', 'IN PROGRESS');

    expect(result.status).toBe(0);
    expect(read(root, `${PLAN_DIR}/ROADMAP.md`)).toContain(
      '- [~] **Phase 2: Beta** · Status: IN PROGRESS · [sub-plan](phase-2-beta.md)\n',
    );
    expect(read(root, `${PLAN_DIR}/ROADMAP.md`)).toContain(
      '- [ ] **Phase 1: Alpha** · Status: TODO · [sub-plan](phase-1-alpha.md) · After: none',
    );
    expect(read(root, `${PLAN_DIR}/phase-1-alpha.md`)).toBe(alpha());
  });
});

describe('plan-state set --slice', () => {
  it('keeps the padding of a padded table and touches only that cell', () => {
    const root = installedRepo();
    stagePlan(root);

    const result = set(root, PLAN_DIR, '1', '--slice', '1b', 'IN REVIEW');

    expect(result.status).toBe(0);
    expect(read(root, `${PLAN_DIR}/phase-1-alpha.md`)).toBe(
      alpha(
        PADDED_TABLE.replace(
          '| 1b  | `src/b.ts` | 1a      | 2    | TODO        |',
          '| 1b  | `src/b.ts` | 1a      | 2    | IN REVIEW   |',
        ),
      ),
    );
  });

  it('widens a padded cell the value does not fit', () => {
    const root = installedRepo();
    stagePlan(root, {
      alpha: alpha(
        PADDED_TABLE.replace('| status      |', '| status |').replace(
          /\| TODO {8}\|/g,
          '| TODO |',
        ),
      ),
    });

    const result = set(root, PLAN_DIR, '1', '--slice', '1a', 'DISPATCHED');

    expect(result.status).toBe(0);
    expect(read(root, `${PLAN_DIR}/phase-1-alpha.md`)).toContain(
      '| 1a  | `src/a.ts` | none    | 1    | DISPATCHED |',
    );
  });

  it('writes an unpadded table with one space on each side when the value outgrows the cell', () => {
    const root = installedRepo();
    stagePlan(root, { alpha: alpha(UNPADDED_TABLE) });

    const result = set(root, PLAN_DIR, '1', '--slice', '1a', 'DONE');

    expect(result.status).toBe(0);
    expect(read(root, `${PLAN_DIR}/phase-1-alpha.md`)).toBe(
      alpha(
        UNPADDED_TABLE.replace(
          '|1a|`src/a.ts`|none|1|TODO|',
          '|1a|`src/a.ts`|none|1| DONE |',
        ),
      ),
    );
  });

  it('leaves the ROADMAP untouched', () => {
    const root = installedRepo();
    stagePlan(root);

    set(root, PLAN_DIR, '1', '--slice', '1a', 'DONE');

    expect(read(root, `${PLAN_DIR}/ROADMAP.md`)).toBe(ROADMAP);
  });
});

describe('plan-state set refusals', () => {
  it.each([
    {
      name: 'an unknown slice id',
      args: ['1', '--slice', '9z', 'DONE'],
      alphaText: alpha(),
      roadmap: ROADMAP,
      exit: 1,
    },
    {
      name: 'a sub-plan with no Slices table',
      args: ['1', '--slice', '1a', 'DONE'],
      alphaText: alpha(''),
      roadmap: ROADMAP,
      exit: 1,
    },
    {
      name: '--log on a ROADMAP with no Log section',
      args: ['1', 'DONE', '--log', 'landed'],
      alphaText: alpha(),
      roadmap: ROADMAP.replace(/## Log[\s\S]*## Appendix/, '## Appendix'),
      exit: 1,
    },
    {
      name: 'a sub-plan with no Status header on a phase set',
      args: ['1', 'DONE'],
      alphaText: '# Phase 1: alpha\n',
      roadmap: ROADMAP,
      exit: 1,
    },
    {
      name: 'a phase argument with no status',
      args: ['1'],
      alphaText: alpha(),
      roadmap: ROADMAP,
      exit: 2,
    },
    {
      name: '--slice with no phase',
      args: ['--slice', '1a', '--log', 'x'],
      alphaText: alpha(),
      roadmap: ROADMAP,
      exit: 2,
    },
  ])(
    'exits $exit and writes nothing for $name',
    ({ args, alphaText, roadmap, exit }) => {
      const root = installedRepo();
      stagePlan(root, { roadmap, alpha: alphaText });
      const before = snapshot(root);

      const result = set(root, PLAN_DIR, ...args);

      expect(result.status).toBe(exit);
      expect(snapshot(root)).toEqual(before);
    },
  );

  it('prints the usage lines for malformed arguments', () => {
    const root = installedRepo();
    stagePlan(root);

    const result = set(root, PLAN_DIR);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      'plan-state.mjs set <workspace> --log <line>',
    );
  });
});

describe('plan-state set, a failed second write', () => {
  it('restores the ROADMAP when the sub-plan is read-only', () => {
    const root = installedRepo();
    stagePlan(root);
    chmodSync(join(root, PLAN_DIR, 'phase-1-alpha.md'), 0o444);

    const result = set(root, PLAN_DIR, '1', 'DONE');

    expect(result.status).toBe(1);
    expect(read(root, `${PLAN_DIR}/ROADMAP.md`)).toBe(ROADMAP);
    expect(read(root, `${PLAN_DIR}/phase-1-alpha.md`)).toBe(alpha());
  });
});

describe('plan-state set --log', () => {
  const today = todayLocal();

  it('with no phase appends one dated line after the last Log line and bumps Updated', () => {
    const root = installedRepo();
    stagePlan(root);

    const result = set(root, PLAN_DIR, '--log', 'plan reshaped');

    expect(result.status).toBe(0);
    expect(read(root, `${PLAN_DIR}/ROADMAP.md`)).toBe(
      ROADMAP.replace(
        '**Updated:** 2026-01-02',
        `**Updated:** ${today}`,
      ).replace(
        '- 2026-01-02: second line\n',
        `- 2026-01-02: second line\n- ${today}: plan reshaped\n`,
      ),
    );
    expect(read(root, `${PLAN_DIR}/phase-1-alpha.md`)).toBe(alpha());
  });

  it('combined with a phase status writes both in one call', () => {
    const root = installedRepo();
    stagePlan(root);

    const result = set(
      root,
      PLAN_DIR,
      '1',
      'DONE',
      '--log',
      'alpha landed, beta next',
    );

    expect(result.status).toBe(0);
    const roadmap = read(root, `${PLAN_DIR}/ROADMAP.md`);
    expect(roadmap).toContain(
      `- 2026-01-02: second line\n- ${today}: alpha landed, beta next\n\n## Appendix`,
    );
    expect(roadmap).toContain(
      `- [x] **Phase 1: Alpha** · Status: DONE (${today})`,
    );
    expect(read(root, `${PLAN_DIR}/phase-1-alpha.md`)).toContain(
      `**Status:** DONE (${today}) · `,
    );
  });

  it('combined with a slice status writes the row and the Log line', () => {
    const root = installedRepo();
    stagePlan(root);

    const result = set(
      root,
      PLAN_DIR,
      '1',
      '--slice',
      '1a',
      'DONE',
      '--log',
      'slice 1a done',
    );

    expect(result.status).toBe(0);
    expect(read(root, `${PLAN_DIR}/ROADMAP.md`)).toBe(
      ROADMAP.replace(
        '**Updated:** 2026-01-02',
        `**Updated:** ${today}`,
      ).replace(
        '- 2026-01-02: second line\n',
        `- 2026-01-02: second line\n- ${today}: slice 1a done\n`,
      ),
    );
    expect(read(root, `${PLAN_DIR}/phase-1-alpha.md`)).toContain(
      '| 1a  | `src/a.ts` | none    | 1    | DONE        |',
    );
  });

  it('appends at the end of the file when the Log is the last section', () => {
    const root = installedRepo();
    stagePlan(root, {
      roadmap: ROADMAP.replace('\n## Appendix\n\nkept\n', ''),
    });

    const result = set(root, PLAN_DIR, '--log', 'tail line');

    expect(result.status).toBe(0);
    expect(read(root, `${PLAN_DIR}/ROADMAP.md`)).toMatch(
      new RegExp(`- 2026-01-02: second line\\n- ${today}: tail line\\n$`),
    );
  });
});

describe('plan-state set on a milestone directory', () => {
  it('exits 1 naming each member that holds a ROADMAP and writes nothing', () => {
    const root = installedRepo();
    put(root, 'ms/MILESTONE.md', '# Milestone\n');
    put(root, 'ms/first/ROADMAP.md', ROADMAP);
    put(root, 'ms/second/ROADMAP.md', ROADMAP);
    put(root, 'ms/notes/readme.md', 'no roadmap\n');

    const result = set(root, 'ms', '1', 'DONE');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ms/first, ms/second');
    expect(result.stderr).not.toContain('ms/notes');
    expect(read(root, 'ms/MILESTONE.md')).toBe('# Milestone\n');
  });
});

describe('plan-state set output passes plan-lint', () => {
  function lintRoot(): string {
    const root = useInstalledRepo('pnpm-monorepo', {
      modules: 'plans,orchestrate',
    });
    put(root, `${PLAN_DIR}/PLAN.md`, '# Plan\n');
    stagePlan(root);
    return root;
  }

  it('exits 0 before any set, so the fixture is a clean baseline', () => {
    const root = lintRoot();

    const result = runScript(root, '.claude/scripts/plan-lint.mjs');

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('exits 0 after a phase set with a log line', () => {
    const root = lintRoot();
    set(root, PLAN_DIR, '1', 'DONE', '--log', 'alpha landed');

    const result = runScript(root, '.claude/scripts/plan-lint.mjs');

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it('exits 0 after a slice set', () => {
    const root = lintRoot();
    set(root, PLAN_DIR, '1', '--slice', '1a', 'DISPATCHED');

    const result = runScript(root, '.claude/scripts/plan-lint.mjs');

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
