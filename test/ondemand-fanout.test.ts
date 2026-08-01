import { expect, test } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixture, runCli } from './fixtures.js';

const readJson = (p: string): Record<string, any> =>
  JSON.parse(readFileSync(p, 'utf8'));

test('SW1: sweep module ships the /sweep skill (opt-in); off by default', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    // Off by default.
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    expect(
      !existsSync(join(root, '.claude/skills/sweep/SKILL.md')),
    ).toBeTruthy();

    // Enabled → skill lands, describing the O(shards) discipline.
    expect(runCli(['init', '--yes', '--modules=sweep', root]).status).toBe(0);
    const skillPath = join(root, '.claude/skills/sweep/SKILL.md');
    expect(existsSync(skillPath)).toBeTruthy();
    const text = readFileSync(skillPath, 'utf8');
    expect(text).toMatch(/O\(shards\)/);
    expect(text).toMatch(/haiku|effort: low/);
    expect(runCli(['doctor', root]).status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OR1: orchestrate ships /orchestrate + the sonnet task-worker (opt-in); off by default', () => {
  const off = makeFixture('pnpm-monorepo');
  const root = makeFixture('pnpm-monorepo');
  const skillPath = join(root, '.claude/skills/orchestrate/SKILL.md');
  const agentPath = join(root, '.claude/agents/task-worker.md');
  try {
    expect(runCli(['init', '--yes', off]).status).toBe(0);
    expect(
      !existsSync(join(off, '.claude/skills/orchestrate/SKILL.md')),
      'orchestrate off by default',
    ).toBeTruthy();
    expect(
      !existsSync(join(off, '.claude/agents/task-worker.md')),
    ).toBeTruthy();

    // Fresh root: CLAUDE.md is a user-owned seed, so it only reflects the modules of
    // the init that created it.
    expect(
      runCli(['init', '--yes', '--modules=plans,orchestrate', root]).status,
    ).toBe(0);
    const skillText = readFileSync(skillPath, 'utf8');
    // The load-bearing disciplines: ownership-based slicing, seam-first, report-not-diff.
    expect(skillText).toMatch(/file ownership/i);
    expect(skillText).toMatch(/disjoint/);
    expect(skillText).toMatch(/APPROVE|REVISE|RESLICE/);
    expect(skillText).toMatch(/--auto/);
    // Which plan to drive is explicit, never guessed from mtime/sort order.
    expect(skillText).toMatch(/Resolving which plan/);
    expect(skillText).toMatch(/plan-slug/);
    const agentText = readFileSync(agentPath, 'utf8');
    expect(agentText).toMatch(/model: sonnet/);
    expect(agentText).toMatch(/no diffs/i);

    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(manifest.modules.includes('orchestrate')).toBeTruthy();
    // The CLAUDE.md carve-out to "no implementation subagents" lands with the module.
    const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toMatch(/\/orchestrate/);
    expect(runCli(['doctor', root]).status).toBe(0);
  } finally {
    rmSync(off, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('OR2: orchestrate without plans still installs, and says so in the advisories', () => {
  const root = makeFixture('npm-single');
  try {
    const r = runCli(['init', '--yes', '--modules=orchestrate', root]);
    expect(r.status).toBe(0);
    expect(
      existsSync(join(root, '.claude/skills/orchestrate/SKILL.md')),
    ).toBeTruthy();
    // Degrades gracefully (the `ready` pattern): no plans workspace, but a pointer to it.
    expect(!existsSync(join(root, '.claude/plans/.gitignore'))).toBeTruthy();
    expect(r.stdout).toMatch(/plans/);
    expect(runCli(['doctor', root]).status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PA1: persona-auditor stages its template only when enabled; core never stages it', () => {
  const root = makeFixture('pnpm-monorepo');
  const tmpl = '.claude/kit-templates/agents/persona-auditor.agent.md.template';
  try {
    // Default init: reviewer template lands, persona-auditor does NOT (module-owned).
    expect(runCli(['init', '--yes', root]).status).toBe(0);
    expect(
      existsSync(
        join(root, '.claude/kit-templates/agents/reviewer.agent.md.template'),
      ),
    ).toBeTruthy();
    expect(
      !existsSync(join(root, tmpl)),
      'persona-auditor off by default',
    ).toBeTruthy();

    // Enabled → the template stages, with the anti-anchoring discipline prominent.
    expect(
      runCli(['init', '--yes', '--modules=persona-auditor', root]).status,
    ).toBe(0);
    expect(existsSync(join(root, tmpl))).toBeTruthy();
    const text = readFileSync(join(root, tmpl), 'utf8');
    expect(text).toMatch(/DO NOT ANCHOR|anti-anchor/i);
    expect(text).toMatch(/blindRanking/);
    expect(text).toMatch(/model: haiku/);
    const manifest = readJson(join(root, '.claude/kit-manifest.json'));
    expect(manifest.modules.includes('persona-auditor')).toBeTruthy();
    expect(runCli(['doctor', root]).status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('BR1: plans module also ships the /blast-radius worked-example skill', () => {
  const root = makeFixture('pnpm-monorepo');
  try {
    expect(runCli(['init', '--yes', '--modules=plans', root]).status).toBe(0);
    const skillPath = join(root, '.claude/skills/blast-radius/SKILL.md');
    expect(
      existsSync(skillPath),
      '/blast-radius skill installed with plans',
    ).toBeTruthy();
    const text = readFileSync(skillPath, 'utf8');
    expect(text).toMatch(/\.claude\/plans\/blast-radius-/);
    expect(text).toMatch(/disclaimer|Snapshot at commit/i);
    expect(text).toMatch(/Completeness self-audit/);
    // plan-project still lands too.
    expect(
      existsSync(join(root, '.claude/skills/plan-project/SKILL.md')),
    ).toBeTruthy();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
