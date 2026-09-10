import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';
import { manifestOf } from '#test/installed-tree';
import { options, plan, renderTaskWorkerVariant } from '../orchestrate.js';
import type { Answers, Ctx } from '@houserules/api';
import { payloadPath } from '../../paths.js';

const SOURCE = readFileSync(payloadPath('agents', 'task-worker.md'), 'utf8');
const SOURCE_BODY = SOURCE.slice(SOURCE.indexOf('\n---', 4));

function baseAnswers(overrides: Partial<Answers> = {}): Answers {
  return {
    moduleIds: ['orchestrate'],
    targets: [],
    seedChangesetConfig: false,
    moduleOptions: {},
    ...overrides,
  };
}

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

    it('gives the brief a reference line, so a slice judged against a spec is handed that spec', () => {
      expect(skillText).toMatch(/> Reference:/);
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
      expect(manifest.modules.includes('orchestrate')).toBe(true);
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

    beforeEach(() => {
      root = useInstalledRepo('npm-single', { modules: 'orchestrate' });
    });

    it('still installs', () => {
      expect(
        existsSync(join(root, '.claude/skills/orchestrate/SKILL.md')),
      ).toBe(true);
    });

    it('does not create a plans workspace', () => {
      expect(existsSync(join(root, '.claude/plans/.gitignore'))).toBe(false);
    });

    it('points to the plans module in its advisory output', () => {
      const result = runCli(['init', '--yes', '--modules=orchestrate', root]);

      expect(result.stdout).toMatch(/plans/);
    });

    it('passes doctor', () => {
      expect(runCli(['doctor', root]).status).toBe(0);
    });
  });
});

describe('renderTaskWorkerVariant', () => {
  it('swaps name, effort, and description, leaving tools and model untouched', () => {
    const rendered = renderTaskWorkerVariant('high');

    expect(rendered).toMatch(/^name: task-worker-high$/m);
    expect(rendered).toMatch(/^effort: high$/m);
    expect(rendered).toMatch(
      /^description: Same contract as task-worker at high effort\. Dispatched by \/orchestrate with an objective, owned paths, and an acceptance command\.$/m,
    );
    expect(rendered).toMatch(/^tools: Read, Edit, Write, Grep, Glob, Bash$/m);
    expect(rendered).toMatch(/^model: sonnet$/m);
  });

  it('keeps the body byte-identical to the source body', () => {
    expect(renderTaskWorkerVariant('low').endsWith(SOURCE_BODY)).toBe(true);
  });
});

describe('orchestrate plan(), effort variant selection', () => {
  const ctx = {} as Ctx;

  it('emits no variant write actions when the selection is empty', () => {
    const actions = plan(
      ctx,
      baseAnswers({ moduleOptions: { orchestrate: [] } }),
    );

    expect(actions.some((a) => a.kind === 'write')).toBe(false);
  });

  it('emits a write action per selected effort', () => {
    const actions = plan(
      ctx,
      baseAnswers({ moduleOptions: { orchestrate: ['high'] } }),
    );

    const writes = actions.filter((a) => a.kind === 'write');
    expect(writes.map((a) => a.dest)).toEqual([
      '.claude/agents/task-worker-high.md',
    ]);
  });

  it('produces low and xhigh when resolved to the module’s declared defaults', () => {
    const actions = plan(
      ctx,
      baseAnswers({ moduleOptions: { orchestrate: options.defaults } }),
    );

    const writes = actions.filter((a) => a.kind === 'write');
    expect(writes.map((a) => a.dest)).toEqual([
      '.claude/agents/task-worker-low.md',
      '.claude/agents/task-worker-xhigh.md',
    ]);
  });
});
