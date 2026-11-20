import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'closeout.mts',
);

function closeout(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'closeout-'));
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const ROADMAP = (...lines: string[]) =>
  `# ROADMAP: demo\n\n## Phases\n\n${lines.join('\n')}\n\nTrailing prose.\n`;

function workspace(): string {
  const dir = tmp();
  write(
    join(dir, 'ROADMAP.md'),
    ROADMAP(
      '- [x] **Phase 1: alpha** · Status: DONE (2026-11-20) · [sub-plan](phase-1-alpha.md) · After: none',
      '- [x] **Phase 2: beta** · Status: DONE · [sub-plan](phase-2-beta.md) · After: none',
      '- [ ] **Phase 3: gamma** · Status: IN PROGRESS · [sub-plan](phase-3-gamma.md) · After: 1',
      '- [ ] **Phase 4: delta** · Status: BLOCKED · [sub-plan](phase-4-delta.md) · After: 1',
      '- [ ] **Phase 5: empty** · Status: TODO · [sub-plan](phase-5-empty.md) · After: none',
    ),
  );
  write(
    join(dir, 'phase-1-alpha.md'),
    `# Phase 1: alpha

**Status:** DONE · **Part of:** [PLAN.md](PLAN.md)
**Domain:** \`src/a.ts\`
**Closes:**   #317 ,#318,   #319

## Objective

Ship the alpha thing. Done when
\`pnpm test\` passes
and the docs read well.

## Steps

- [x] **One.** Do the first thing.
      Acceptance: the first test passes.
- [x] **Two.** Do the second thing across
      several lines. Acceptance: a case wraps
      over two lines and still joins.
- [x] **Three.** No acceptance here.
- [x] **Four.** Print one per step \`Acceptance:\` clause, then
      a real one. Acceptance: the quoted marker is ignored.

## Notes

Acceptance: not in steps, so ignored.
`,
  );
  write(
    join(dir, 'phase-2-beta.md'),
    `# Phase 2: beta

**Closes:** #318, #320

## Objective

Beta is small. Done when it works.

## Steps

- [x] **One.** Acceptance: beta works.
`,
  );
  write(
    join(dir, 'phase-3-gamma.md'),
    '# Phase 3\n\n**Closes:** #330, #331\n\n## Objective\n\nDone when gamma.\n',
  );
  write(
    join(dir, 'phase-4-delta.md'),
    '# Phase 4\n\n**Closes:** #340\n\n## Objective\n\nDone when delta.\n',
  );
  write(
    join(dir, 'phase-5-empty.md'),
    '# Phase 5\n\n## Objective\n\nNothing.\n',
  );
  return dir;
}

describe('closeout checklist', () => {
  it('prints each phase with its done clause and acceptance clauses', () => {
    const dir = workspace();
    const result = closeout(['checklist', dir], tmp());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`## Phase 1: alpha
- [ ] Done when \`pnpm test\` passes and the docs read well.
- [ ] the first test passes.
- [ ] a case wraps over two lines and still joins.
- [ ] the quoted marker is ignored.

## Phase 2: beta
- [ ] Done when it works.
- [ ] beta works.

## Phase 3: gamma
- [ ] Done when gamma.

## Phase 4: delta
- [ ] Done when delta.

## Phase 5: empty
`);
  });
});

describe('closeout closes', () => {
  it('prints DONE phases issues once each and exits 1 for unfinished ones', () => {
    const dir = workspace();
    const result = closeout(['closes', dir], tmp());
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      'Closes #317\nCloses #318\nCloses #319\nCloses #320\n',
    );
    expect(result.stderr).toContain('Phase 3 (IN PROGRESS)');
    expect(result.stderr).toContain('#330');
    expect(result.stderr).toContain('#331');
    expect(result.stderr).toContain('Phase 4 (BLOCKED)');
    expect(result.stderr).toContain('#340');
    expect(result.stdout).not.toContain('#33');
    expect(result.stdout).not.toContain('#340');
  });

  it('exits 0 when every listing phase is DONE', () => {
    const dir = tmp();
    write(
      join(dir, 'ROADMAP.md'),
      ROADMAP(
        '- [x] **Phase 1: a** · Status: DONE (2026-11-20) · [sub-plan](p1.md) · After: none',
        '- [ ] **Phase 2: b** · Status: TODO · [sub-plan](p2.md) · After: 1',
      ),
    );
    write(join(dir, 'p1.md'), '# P1\n\n**Closes:** #5\n');
    write(join(dir, 'p2.md'), '# P2\n\n## Objective\n\nDone when b.\n');
    const result = closeout(['closes', dir], tmp());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('Closes #5\n');
  });

  it('exits 1 naming file and line for a malformed Closes line', () => {
    const dir = tmp();
    write(
      join(dir, 'ROADMAP.md'),
      ROADMAP(
        '- [x] **Phase 1: a** · Status: DONE · [sub-plan](p1.md) · After: none',
      ),
    );
    write(join(dir, 'p1.md'), '# P1\n\nintro\n**Closes:** 317, #abc\n');
    const result = closeout(['closes', dir], tmp());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('p1.md:4:');
    expect(result.stdout).toBe('');
  });
});

describe('closeout sources', () => {
  it('passes when every backticked path exists', () => {
    const dir = tmp();
    write(join(dir, 'a.md'), 'a');
    write(join(dir, 'b', 'c.txt'), 'c');
    write(join(dir, 'REPORT.md'), 'Intro\nSource: `a.md`, `b/c.txt`\n');
    const result = closeout(['sources', join(dir, 'REPORT.md')], tmp());
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('resolves ../ paths from the report directory, not the cwd', () => {
    const dir = tmp();
    write(join(dir, 'shared.md'), 'x');
    write(
      join(dir, 'sub', 'REPORT.md'),
      'Source: `../shared.md`, `../gone.md`\n',
    );
    const elsewhere = tmp();
    write(join(elsewhere, 'gone.md'), 'decoy');
    const file = join(dir, 'sub', 'REPORT.md');
    const result = closeout(['sources', file], elsewhere);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(`${file}:1: ../gone.md does not exist\n`);
  });

  it('flags a Source line with no backticked path', () => {
    const dir = tmp();
    write(join(dir, 'REPORT.md'), 'ok\nSource: see the thread\n');
    const file = join(dir, 'REPORT.md');
    const result = closeout(['sources', file], tmp());
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(
      `${file}:2: Source line names no backticked path\n`,
    );
  });
});

describe('closeout usage errors', () => {
  const cwd = tmp();
  it.each([
    [[]],
    [['bogus', '.']],
    [['checklist']],
    [['closes', '/no/such/dir-xyz']],
    [['sources', '/no/such/file-xyz.md']],
    [['checklist', tmp()]],
  ])('exits 2 for %j', (args) => {
    const result = closeout(args, cwd);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: closeout.mjs');
  });
});
