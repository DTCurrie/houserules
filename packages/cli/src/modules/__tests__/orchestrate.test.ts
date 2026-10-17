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
  hint,
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
    expect(
      existsSync(join(off, '.claude/agents/phase-orchestrator.md')),
      'phase-orchestrator agent not installed',
    ).toBe(false);
  });

  describe('enabled together with the plans module', () => {
    let root: string;
    let skillText: string;
    let agentText: string;
    let orchestratorText: string;
    let nestedText: string;

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
      orchestratorText = readFileSync(
        join(root, '.claude/agents/phase-orchestrator.md'),
        'utf8',
      );
      nestedText = readFileSync(
        join(root, '.claude/skills/orchestrate/references/nested.md'),
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

    it('installs a sonnet phase-orchestrator that preloads the orchestrate skill', () => {
      expect(orchestratorText).toMatch(/^model: sonnet$/m);
      expect(orchestratorText).toMatch(/^skills: orchestrate$/m);
    });

    it.each(['Agent', 'SendMessage', 'Skill'])(
      'gives the phase-orchestrator the %s tool',
      (tool) => {
        const toolsLine = orchestratorText.match(/^tools: .*$/m)?.[0] ?? '';

        expect(toolsLine.slice('tools: '.length).split(', ')).toContain(tool);
      },
    );

    it('installs the nested reference beside the other orchestrate references', () => {
      expect(
        existsSync(
          join(root, '.claude/skills/orchestrate/references/nested.md'),
        ),
        'nested.md installed',
      ).toBe(true);
    });

    it('lists --flat in the invocation table as the run that stays at this layer', () => {
      expect(skillText).toMatch(/^\| `… --flat` .*here/m);
    });

    it('names one layer down as the default in §4 and points at references/nested.md', () => {
      expect(skillText).toMatch(
        /By default, §1 through §8 run one layer down[^\n]*\n[^\n]*references\/nested\.md/,
      );
    });

    it('tells the phase-orchestrator to run the skill at its own layer and never nest again', () => {
      expect(orchestratorText).toMatch(/never spawn a\s+`phase-orchestrator`/);
    });

    it('leaves no installed orchestrate surface describing --nested as a flag', () => {
      expect(
        [skillText, nestedText, orchestratorText].join('\n'),
      ).not.toContain('--nested');
    });

    it('orders the phase-orchestrator report headings from status table to resume', () => {
      const headings = [
        'Status table',
        'Landed',
        'Verify',
        'Ruling needed',
        'Rulings made',
        'Backlogged',
        'Out of scope',
        'Requests',
        'Decide candidates',
        'Resume',
      ];

      const reportStart = orchestratorText.indexOf('## Report format');

      expect(reportStart, 'report format section present').not.toBe(-1);

      const positions = headings.map((heading) =>
        orchestratorText.indexOf(heading, reportStart),
      );

      expect(positions, 'every heading present').not.toContain(-1);
      expect(positions).toEqual(
        [...positions].sort((earlier, later) => earlier - later),
      );
      expect(new Set(positions).size).toBe(headings.length);
    });

    it.each([
      'Plan:',
      'Phase:',
      'Mode:',
      'Gates:',
      'Domain:',
      'Siblings:',
      'Seam:',
      'Ruling:',
    ])('defines the %s brief label in nested.md', (label) => {
      expect(nestedText).toContain(label);
    });

    it.each([
      'plan-tie',
      'check-in',
      'blocked-slice',
      'needs-context',
      'context-size',
      'depth-limit',
    ])('names the %s gate in nested.md', (gate) => {
      expect(nestedText).toContain(gate);
    });

    it('merges several orchestrators into one table with the Plan column first', () => {
      expect(nestedText).toMatch(/^\| Plan +\| Slice +\| Owns +\| State +\|$/m);
    });

    it('resumes only the orchestrator that asked for a ruling, tagged with its plan', () => {
      expect(nestedText).toMatch(/tagged with its plan/);
      expect(nestedText).toMatch(/resume only the agent\s+that asked/);
    });

    it('keeps the seam with the main conversation and routes a change up as a request', () => {
      expect(nestedText).toMatch(/Neither orchestrator edits the seam/);
      expect(nestedText).toMatch(/comes up as\s+a `Requests` line/);
    });

    it('runs the repo-wide fixer and verify once, after every orchestrator returns DONE', () => {
      expect(nestedText).toMatch(
        /After every orchestrator has returned `DONE`[^.]*repo-wide fixer and `\/verify-changed` once/,
      );
    });

    it('tells the phase-orchestrator to report sibling findings and seam changes upward', () => {
      expect(orchestratorText).toMatch(/Out of scope/);
      expect(orchestratorText).toMatch(/Requests/);
    });

    it('records the phase-orchestrator and nested reference in the manifest', () => {
      const dests = Object.keys(manifestOf(root).files);

      expect(dests).toContain('.claude/agents/phase-orchestrator.md');
      expect(dests).toContain(
        '.claude/skills/orchestrate/references/nested.md',
      );
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

    it('tells the orchestrator to pass effort on the Agent call and names no effort variant', () => {
      expect(skillText).toMatch(/Agent tool's `effort` parameter/);
      expect(skillText).not.toMatch(/task-worker-(low|high|xhigh)/);
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
  it('has research as its only variant', () => {
    expect(options.choices.map((choice) => choice.value)).toEqual(['research']);
    expect(options.defaults).toEqual(['research']);
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

describe('renderTaskWorkerBase, given a server pattern', () => {
  it('writes the pattern onto the tools line unchanged', () => {
    const rendered = renderTaskWorkerBase(['mcp__x']);

    expect(rendered).toMatch(
      /^tools: Read, Edit, Write, Grep, Glob, Bash, mcp__x$/m,
    );
  });
});

describe('orchestrate plan(), variant selection', () => {
  const ctx = {} as Ctx;

  it('emits no variant write actions when the selection is empty', () => {
    const actions = plan(
      ctx,
      baseAnswers({ moduleOptions: { orchestrate: [] } }),
    );

    expect(actions.filter((a) => a.kind === 'write')).toEqual([]);
  });

  it('ignores a retired effort value left in a saved selection', () => {
    const actions = plan(
      ctx,
      baseAnswers({ moduleOptions: { orchestrate: ['low', 'xhigh'] } }),
    );

    expect(actions.filter((a) => a.kind === 'write')).toEqual([]);
  });

  it('produces only research when resolved to the module’s declared defaults', () => {
    const actions = plan(
      ctx,
      baseAnswers({ moduleOptions: { orchestrate: options.defaults } }),
    );

    const writes = actions.filter((a) => a.kind === 'write');
    expect(writes.map((a) => a.dest)).toEqual([
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
      baseAnswers({ moduleOptions: { orchestrate: ['research'] } }),
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

describe('orchestrate plan(), phase-orchestrator', () => {
  const withTools = {
    claude: {
      houseConfig: {
        orchestrate: { workerTools: ['mcp__svelte__svelte-autofixer'] },
      },
    },
  } as Ctx;

  it.each([
    { name: 'without orchestrate.workerTools', ctx: {} as Ctx },
    { name: 'with orchestrate.workerTools', ctx: withTools },
  ])('copies the agent unchanged $name', ({ ctx }) => {
    const actions = plan(ctx, baseAnswers());

    expect(
      actions.some(
        (action) =>
          action.kind === 'copy' &&
          action.dest === '.claude/agents/phase-orchestrator.md',
      ),
    ).toBe(true);
    expect(
      actions.some(
        (action) =>
          action.kind === 'write' &&
          action.dest === '.claude/agents/phase-orchestrator.md',
      ),
      'not written with extra tools',
    ).toBe(false);
  });

  it('advises that each phase runs one layer down by default and --flat keeps it here', () => {
    const answers = { ...baseAnswers(), moduleIds: ['orchestrate', 'plans'] };
    const advice = plan({} as Ctx, answers).flatMap((action) =>
      action.kind === 'advise' ? [action.text] : [],
    );

    expect(advice.join('\n')).toMatch(
      /By default it hands each phase to a sonnet phase-orchestrator[^]*--flat keeps the slicing/,
    );
  });

  it('hints the one-layer-down default', () => {
    expect(hint()).toMatch(/phase-orchestrator/);
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
      baseAnswers({ moduleOptions: { orchestrate: ['research'] } }),
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

    const researchWrite = actions.find(
      (a) =>
        a.kind === 'write' &&
        a.dest === '.claude/agents/task-worker-research.md',
    );
    expect((researchWrite as { content: string }).content).toMatch(
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
