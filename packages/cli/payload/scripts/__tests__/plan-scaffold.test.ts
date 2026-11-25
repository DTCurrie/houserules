import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runScript } from '#test/run';

const SCRIPT = '.claude/scripts/plan-scaffold.mjs';

function installedRepo(): string {
  return useInstalledRepo('pnpm-monorepo', { modules: 'plans,orchestrate' });
}

function scaffold(root: string, ...args: string[]) {
  return runScript(root, SCRIPT, { args });
}

function read(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    out[entry] = readFileSync(join(dir, entry), 'utf8');
  }
  return out;
}

const DIR = '.claude/plans/demo';
const CALL = ['demo', '--phases', 'alpha,beta-two', '--date', '2026-01-02'];

describe('plan-scaffold arguments', () => {
  it('exits 2 on an unknown flag and writes nothing', () => {
    const root = installedRepo();

    const result = scaffold(root, 'demo', '--phases', 'a', '--bogus');

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown flag --bogus');
    expect(existsSync(join(root, DIR))).toBe(false);
  });

  it('exits 2 when the slug or --phases is missing', () => {
    const root = installedRepo();

    expect(scaffold(root, '--phases', 'a').status).toBe(2);
    expect(scaffold(root, 'demo').status).toBe(2);
    expect(existsSync(join(root, DIR))).toBe(false);
  });

  it('exits 2 on a bad date and on duplicate phase slugs', () => {
    const root = installedRepo();

    expect(
      scaffold(root, 'demo', '--phases', 'a', '--date', '1/2/26').status,
    ).toBe(2);
    const duplicate = scaffold(root, 'demo', '--phases', 'a,b,a');
    expect(duplicate.status).toBe(2);
    expect(duplicate.stderr).toContain('"a"');
    expect(existsSync(join(root, DIR))).toBe(false);
  });

  it('names a non-kebab slug and a non-kebab phase slug', () => {
    const root = installedRepo();

    const badSlug = scaffold(root, 'Bad_Slug', '--phases', 'a');
    const badPhase = scaffold(root, 'demo', '--phases', 'a,Not/Kebab');
    const nested = scaffold(root, 'ms/member', '--phases', 'a');

    expect(badSlug.status).toBe(2);
    expect(badSlug.stderr).toContain('"Bad_Slug"');
    expect(badPhase.status).toBe(2);
    expect(badPhase.stderr).toContain('"Not/Kebab"');
    expect(nested.status).toBe(2);
    expect(existsSync(join(root, '.claude/plans/ms'))).toBe(false);
  });
});

describe('plan-scaffold output', () => {
  it('writes the three kinds of file as full literals and prints each path', () => {
    const root = installedRepo();

    const result = scaffold(root, ...CALL);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      [
        `${DIR}/PLAN.md`,
        `${DIR}/ROADMAP.md`,
        `${DIR}/phase-1-alpha.md`,
        `${DIR}/phase-2-beta-two.md`,
        '',
      ].join('\n'),
    );
    expect(read(root, `${DIR}/PLAN.md`)).toBe(`# PLAN: demo

**Created:** 2026-01-02 · **Status:** see [ROADMAP.md](ROADMAP.md)

## Goal

<One paragraph: what we're building and why. The problem, not the steps.>

## Approach

<The high-level strategy: key decisions, constraints, explicit non-goals.>

## Phases

1. **alpha**: <one line> → [phase-1-alpha.md](phase-1-alpha.md)
2. **beta-two**: <one line> → [phase-2-beta-two.md](phase-2-beta-two.md)

## Key files & interfaces

<The load-bearing files/APIs this work touches, and where a resuming session should look first.>
`);
    expect(read(root, `${DIR}/ROADMAP.md`)).toBe(`# ROADMAP: demo

**Status:** TODO · **Started:** 2026-01-02 · **Updated:** 2026-01-02

> Resuming? Read this file's status lines below. Do not re-derive scope from the transcript.

## Phases

- [ ] **Phase 1: alpha** · Status: TODO · [sub-plan](phase-1-alpha.md)
- [ ] **Phase 2: beta-two** · Status: TODO · [sub-plan](phase-2-beta-two.md)

## Log

- 2026-01-02: scaffolded.
`);
    expect(read(root, `${DIR}/phase-2-beta-two.md`)).toBe(`# Phase 2: beta-two

**Status:** TODO · **Part of:** [PLAN.md](PLAN.md) · **Roadmap:** [ROADMAP.md](ROADMAP.md)

## Objective

<What "done" means here: the falsifiable acceptance from step 2.>

## Reference

<Relative links to any spec, format, or standard this phase's work must conform to, or "none".>

## Standing rulings

none

## Steps

- [ ] <step: the decision made, plus the acceptance that shows it holds. Never a code block>
- [ ] <step>

## Notes & decisions

<A log of how a decision was reached: what you weighed, what you ruled out, surprises. The decision
itself lands in \`## Steps\` or \`## Standing rulings\`.>
`);
  });

  it('places a Standing rulings section above Steps in a generated phase file', () => {
    const root = installedRepo();
    scaffold(root, ...CALL);

    const phase = read(root, `${DIR}/phase-1-alpha.md`);

    expect(phase).toContain('## Standing rulings\n\nnone\n');
    expect(phase.indexOf('## Standing rulings')).toBeGreaterThan(-1);
    expect(phase.indexOf('## Standing rulings')).toBeLessThan(
      phase.indexOf('## Steps'),
    );
  });

  it('reads back through plan-state show as TODO with no mismatch', () => {
    const root = installedRepo();
    scaffold(root, ...CALL);

    const result = runScript(root, '.claude/scripts/plan-state.mjs', {
      args: ['show', DIR, '--json'],
    });

    expect(result.status, result.stderr).toBe(0);
    const phases = JSON.parse(result.stdout).phases;
    expect(phases).toHaveLength(2);
    for (const phase of phases) {
      expect(phase.roadmapStatus).toBe('TODO');
      expect(phase.headerStatus).toBe('TODO');
      expect(phase.mismatch).toBe(false);
    }
  });

  it('passes plan-lint with no error', () => {
    const root = installedRepo();
    scaffold(root, ...CALL);

    const result = runScript(root, '.claude/scripts/plan-lint.mjs');

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

describe('plan-scaffold refusals', () => {
  it('exits 1 on an existing workspace and leaves it byte-identical', () => {
    const root = installedRepo();
    scaffold(root, ...CALL);
    const before = snapshot(join(root, DIR));

    const result = scaffold(root, 'demo', '--phases', 'other,more');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(DIR);
    expect(snapshot(join(root, DIR))).toEqual(before);
  });

  it('exits 1 on an existing empty directory and on a file of that name', () => {
    const root = installedRepo();
    mkdirSync(join(root, '.claude/plans/empty'), { recursive: true });
    writeFileSync(join(root, '.claude/plans/afile'), 'x');

    expect(scaffold(root, 'empty', '--phases', 'a').status).toBe(1);
    expect(scaffold(root, 'afile', '--phases', 'a').status).toBe(1);
    expect(readdirSync(join(root, '.claude/plans/empty'))).toEqual([]);
    expect(read(root, '.claude/plans/afile')).toBe('x');
  });
});

describe('plans module install', () => {
  it('ships plan-scaffold.mjs', () => {
    const root = installedRepo();

    expect(existsSync(join(root, SCRIPT))).toBe(true);
  });
});
