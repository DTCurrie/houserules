import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';
import { manifestOf } from '#test/installed-tree';

describe('plans', () => {
  describe('when enabled', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', { modules: 'plans' });
    });

    it('ships the /blast-radius worked-example skill', () => {
      const skillPath = join(root, '.claude/skills/blast-radius/SKILL.md');
      expect(existsSync(skillPath)).toBeTruthy();
      const text = readFileSync(skillPath, 'utf8');
      expect(text).toMatch(/\.claude\/plans\/blast-radius-/);
      expect(text).toMatch(/disclaimer|Snapshot at commit/i);
      expect(text).toMatch(/Completeness self-audit/);
    });

    it('installs the /plan-project skill without wiring a hook', () => {
      expect(
        existsSync(join(root, '.claude/skills/plan-project/SKILL.md')),
      ).toBeTruthy();
      const manifest = manifestOf(root);
      expect(manifest.modules.includes('plans')).toBeTruthy();
    });

    it('templates a phase doc with a Reference section for the spec its work must conform to', () => {
      const text = readFileSync(
        join(root, '.claude/skills/plan-project/SKILL.md'),
        'utf8',
      );
      expect(text).toMatch(/## Reference\n\n<[^>]*"none"[^>]*>/);
    });

    it('self-gitignores its plan workspace while keeping the .gitignore itself tracked', () => {
      const ignore = readFileSync(
        join(root, '.claude/plans/.gitignore'),
        'utf8',
      );
      expect(ignore).toMatch(/^\*$/m);
      expect(ignore).toMatch(/^!\.gitignore$/m);
    });

    it('adds a CLAUDE.md pointer naming /plan-project and the ROADMAP resume discipline', () => {
      const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
      expect(claudeMd).toMatch(/\/plan-project\b/);
      expect(claudeMd).toMatch(/\.claude\/plans\//);
      expect(claudeMd).toMatch(/ROADMAP/);
    });

    it('does not add a nested plans/CLAUDE.md, since that would never auto-load', () => {
      expect(existsSync(join(root, '.claude/plans/CLAUDE.md'))).toBe(false);
    });

    it('passes doctor validation', () => {
      expect(runCli(['doctor', root]).status).toBe(0);
    });
  });

  describe('by default', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo');
    });

    it('is not enabled', () => {
      const manifest = manifestOf(root);
      expect(manifest.modules.includes('plans')).toBe(false);
    });

    it('installs no skill or workspace', () => {
      expect(
        existsSync(join(root, '.claude/skills/plan-project/SKILL.md')),
      ).toBe(false);
      expect(existsSync(join(root, '.claude/plans/.gitignore'))).toBe(false);
    });

    it('adds no CLAUDE.md pointer', () => {
      const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
      expect(claudeMd.includes('/plan-project')).toBe(false);
      expect(claudeMd.includes('.claude/plans/')).toBe(false);
    });
  });
});
