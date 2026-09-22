import { beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';
import { manifestOf } from '#test/installed-tree';
import {
  check,
  options,
  plan,
  renderTaskWorkerBase,
  renderTaskWorkerVariant,
} from '../orchestrate.js';
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
    expect(
      existsSync(join(off, '.claude/skills/orchestrate/SKILL.md')),
      'orchestrate skill not installed',
    ).toBe(false);
    expect(
      existsSync(join(off, '.claude/agents/task-worker.md')),
      'task-worker agent not installed',
    ).toBe(false);
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
      expect(manifest.modules).toContain('orchestrate');
    });

    it('adds the /orchestrate carve-out against implementation subagents to CLAUDE.md', () => {
      const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
      expect(claudeMd).toMatch(/\/orchestrate/);
    });

    it('passes doctor', () => {
      expect(runCli(['doctor', root]).status).toBe(0);
    });

    it('installs the research variant with WebFetch and WebSearch on its tools line', () => {
      const researchAgentText = readFileSync(
        join(root, '.claude/agents/task-worker-research.md'),
        'utf8',
      );
      expect(researchAgentText).toMatch(/^tools: .*WebFetch, WebSearch$/m);
    });

    it('mentions task-worker-research in the installed SKILL.md', () => {
      expect(skillText).toMatch(/task-worker-research/);
    });

    it('documents orchestrate.workerTools in the installed SKILL.md', () => {
      expect(skillText).toMatch(/orchestrate\.workerTools/);
    });

    it('tells the worker to report a missing required tool under Deviations', () => {
      expect(agentText).toMatch(/tool you do not have/);
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
        'orchestrate skill installed',
      ).toBe(true);
    });

    it('does not create a plans workspace', () => {
      expect(
        existsSync(join(root, '.claude/plans/.gitignore')),
        'no plans workspace created',
      ).toBe(false);
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
    const rendered = renderTaskWorkerVariant('low');
    expect(rendered.slice(-SOURCE_BODY.length)).toBe(SOURCE_BODY);
  });

  it('appends WebFetch and WebSearch to tools and leaves effort untouched for research', () => {
    const rendered = renderTaskWorkerVariant('research');

    expect(rendered).toMatch(/^name: task-worker-research$/m);
    expect(rendered).toMatch(
      /^tools: Read, Edit, Write, Grep, Glob, Bash, WebFetch, WebSearch$/m,
    );
    expect(rendered).toMatch(/^effort: medium$/m);
    expect(rendered).toMatch(/^model: sonnet$/m);
    expect(rendered).toMatch(
      /^description: Same contract as task-worker.*WebFetch.*WebSearch.*$/m,
    );
  });

  it('keeps the body byte-identical to the source body for research', () => {
    const rendered = renderTaskWorkerVariant('research');
    expect(rendered.slice(-SOURCE_BODY.length)).toBe(SOURCE_BODY);
  });

  it('appends extra tools to the research variant, skipping a name already present', () => {
    const rendered = renderTaskWorkerVariant('research', [
      'mcp__svelte__svelte-autofixer',
      'WebFetch',
    ]);

    expect(rendered).toMatch(
      /^tools: Read, Edit, Write, Grep, Glob, Bash, WebFetch, WebSearch, mcp__svelte__svelte-autofixer$/m,
    );
  });
});

describe('renderTaskWorkerBase', () => {
  it('appends extra tools to the base agent, leaving name and effort as the source', () => {
    const rendered = renderTaskWorkerBase([
      'mcp__svelte__svelte-autofixer',
      'WebFetch',
    ]);

    expect(rendered).toMatch(
      /^tools: Read, Edit, Write, Grep, Glob, Bash, mcp__svelte__svelte-autofixer, WebFetch$/m,
    );
    expect(rendered).toMatch(/^name: task-worker$/m);
    expect(rendered).toMatch(/^effort: medium$/m);
    expect(rendered.slice(-SOURCE_BODY.length)).toBe(SOURCE_BODY);
  });
});

describe('orchestrate plan(), effort variant selection', () => {
  const ctx = {} as Ctx;

  it('emits no variant write actions when the selection is empty', () => {
    const actions = plan(
      ctx,
      baseAnswers({ moduleOptions: { orchestrate: [] } }),
    );

    expect(actions.filter((a) => a.kind === 'write')).toEqual([]);
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

  it('produces low, xhigh, and research when resolved to the module’s declared defaults', () => {
    const actions = plan(
      ctx,
      baseAnswers({ moduleOptions: { orchestrate: options.defaults } }),
    );

    const writes = actions.filter((a) => a.kind === 'write');
    expect(writes.map((a) => a.dest)).toEqual([
      '.claude/agents/task-worker-low.md',
      '.claude/agents/task-worker-xhigh.md',
      '.claude/agents/task-worker-research.md',
    ]);
  });

  it('emits exactly one write action for the research variant', () => {
    const actions = plan(
      ctx,
      baseAnswers({ moduleOptions: { orchestrate: ['research'] } }),
    );

    const writes = actions.filter((a) => a.kind === 'write');
    expect(writes.map((a) => a.dest)).toEqual([
      '.claude/agents/task-worker-research.md',
    ]);
  });

  it('emits the base agent as a copy and no variant carries extra tools when the key is unset', () => {
    const actions = plan(
      ctx,
      baseAnswers({ moduleOptions: { orchestrate: ['low'] } }),
    );

    expect(
      actions.some(
        (a) => a.kind === 'copy' && a.dest === '.claude/agents/task-worker.md',
      ),
    ).toBe(true);
    expect(
      actions.some(
        (a) => a.kind === 'write' && a.dest === '.claude/agents/task-worker.md',
      ),
    ).toBe(false);
  });
});

describe('orchestrate plan(), orchestrate.workerTools', () => {
  it('writes the base agent with extra tools and no longer copies it', () => {
    const ctxWithTools = {
      claude: {
        houseConfig: {
          orchestrate: { workerTools: ['mcp__svelte__svelte-autofixer'] },
        },
      },
    } as Ctx;

    const actions = plan(
      ctxWithTools,
      baseAnswers({ moduleOptions: { orchestrate: ['low'] } }),
    );

    const baseWrite = actions.find(
      (a) => a.kind === 'write' && a.dest === '.claude/agents/task-worker.md',
    );
    expect(baseWrite?.kind).toBe('write');
    expect((baseWrite as { content: string }).content).toMatch(
      /^tools: .*mcp__svelte__svelte-autofixer$/m,
    );
    expect(
      actions.some(
        (a) => a.kind === 'copy' && a.dest === '.claude/agents/task-worker.md',
      ),
    ).toBe(false);

    const lowWrite = actions.find(
      (a) =>
        a.kind === 'write' && a.dest === '.claude/agents/task-worker-low.md',
    );
    expect((lowWrite as { content: string }).content).toMatch(
      /^tools: .*mcp__svelte__svelte-autofixer$/m,
    );
  });
});

describe('check', () => {
  function tempRootWithAgent(toolsLine: string): string {
    const root = mkdtempSync(join(tmpdir(), 'orchestrate-check-'));
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'agents', 'task-worker.md'),
      `---\nname: task-worker\n${toolsLine}\nmodel: sonnet\n---\nbody\n`,
    );
    return root;
  }

  it('warns naming the missing tool and pointing at houserules update when a configured tool is absent', () => {
    const root = tempRootWithAgent('tools: Read, Edit, Write');
    const ctx = {
      root,
      claude: {
        agents: ['task-worker.md'],
        houseConfig: {
          orchestrate: { workerTools: ['mcp__svelte__svelte-autofixer'] },
        },
      },
    } as Ctx;

    const result = check(ctx);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.msg).toMatch(/mcp__svelte__svelte-autofixer/);
    expect(result.findings[0]?.msg).toMatch(/houserules update/);
  });

  it('gives no findings when the configured tool is already on the tools line', () => {
    const root = tempRootWithAgent(
      'tools: Read, Edit, Write, mcp__svelte__svelte-autofixer',
    );
    const ctx = {
      root,
      claude: {
        agents: ['task-worker.md'],
        houseConfig: {
          orchestrate: { workerTools: ['mcp__svelte__svelte-autofixer'] },
        },
      },
    } as Ctx;

    const result = check(ctx);

    expect(result.findings).toEqual([]);
  });

  it('gives no findings and no readouts when no key is configured', () => {
    const root = tempRootWithAgent('tools: Read, Edit, Write');
    const ctx = {
      root,
      claude: { agents: ['task-worker.md'], houseConfig: {} },
    } as Ctx;

    const result = check(ctx);

    expect(result.findings).toEqual([]);
    expect(result.readouts).toEqual([]);
  });
});
