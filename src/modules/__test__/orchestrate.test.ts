import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo, useRepo } from '#test/repo';
import { runCli } from '#test/run';
import { manifestOf } from '#test/installed-tree';

describe('orchestrate', () => {
  it('is off by default', () => {
    const off = useInstalledRepo('pnpm-monorepo');
    expect(existsSync(join(off, '.claude/skills/orchestrate/SKILL.md'))).toBe(
      false,
    );
    expect(existsSync(join(off, '.claude/agents/task-worker.md'))).toBe(false);
  });

  describe('enabled together with the plans module', () => {
    let root: string;
    let skillText: string;
    let agentText: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', {
        modules: 'plans,orchestrate',
      });
      skillText = readFileSync(
        join(root, '.claude/skills/orchestrate/SKILL.md'),
        'utf8',
      );
      agentText = readFileSync(
        join(root, '.claude/agents/task-worker.md'),
        'utf8',
      );
    });

    it('documents ownership-based, disjoint slicing and the report-not-diff outcome', () => {
      expect(skillText).toMatch(/file ownership/i);
      expect(skillText).toMatch(/disjoint/);
      expect(skillText).toMatch(/APPROVE|REVISE|RESLICE/);
      expect(skillText).toMatch(/--auto/);
    });

    it('states explicitly which plan is being driven, never guessed from mtime or sort order', () => {
      expect(skillText).toMatch(/Resolving which plan/);
      expect(skillText).toMatch(/plan-slug/);
    });

    it('ships a sonnet task-worker agent instructed to return reports, not diffs', () => {
      expect(agentText).toMatch(/model: sonnet/);
      expect(agentText).toMatch(/no diffs/i);
    });

    it('records the module in the manifest', () => {
      const manifest = manifestOf(root);
      expect(manifest.modules.includes('orchestrate')).toBeTruthy();
    });

    it('adds the /orchestrate carve-out against implementation subagents to CLAUDE.md', () => {
      const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
      expect(claudeMd).toMatch(/\/orchestrate/);
    });

    it('passes doctor', () => {
      expect(runCli(['doctor', root]).status).toBe(0);
    });
  });

  describe('enabled without the plans module', () => {
    let root: string;
    let result: ReturnType<typeof runCli>;

    beforeEach(() => {
      root = useRepo('npm-single');
      result = runCli(['init', '--yes', '--modules=orchestrate', root]);
    });

    it('still installs', () => {
      expect(result.status).toBe(0);
      expect(
        existsSync(join(root, '.claude/skills/orchestrate/SKILL.md')),
      ).toBeTruthy();
    });

    it('does not create a plans workspace', () => {
      expect(existsSync(join(root, '.claude/plans/.gitignore'))).toBe(false);
    });

    it('points to the plans module in its advisory output', () => {
      expect(result.stdout).toMatch(/plans/);
    });

    it('passes doctor', () => {
      expect(runCli(['doctor', root]).status).toBe(0);
    });
  });
});
