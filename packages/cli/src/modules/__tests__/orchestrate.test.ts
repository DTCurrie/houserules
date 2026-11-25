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
  uses,
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
  it('uses the reviewers module', () => {
    expect(uses).toContainEqual({ id: 'reviewers' });
  });

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

    it('writes the single-file acceptance form with -- so the build orchestrator forwards the path instead of dropping it', () => {
      expect(skillText).toMatch(
        /`pnpm --filter <pkg> test -- <path\/to\/file\.test\.ts>`/,
      );
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

    it('installs an opus phase-orchestrator that preloads the orchestrate skill', () => {
      expect(orchestratorText).toMatch(/^model: opus$/m);
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

    it('points the first spawn at the manual-mode reference, which asks before any spawn', () => {
      const manual = readFileSync(
        join(root, '.claude/skills/orchestrate/references/manual-mode.md'),
        'utf8',
      );
      expect(skillText).toMatch(
        /manual mode[^\n]*references\/manual-mode\.md/i,
      );
      expect(manual).toContain('[houserules] Manual mode');
      expect(manual).toContain('own permission prompt');
      expect(manual).toMatch(/Under `--auto` this is still a stop/);
      expect(manual).toMatch(/`BLOCKED` and names the path/);
    });

    it('installs the milestone reference and points a milestone slug at it', () => {
      expect(
        existsSync(
          join(root, '.claude/skills/orchestrate/references/milestone.md'),
        ),
        'milestone.md installed',
      ).toBe(true);
      expect(skillText).toMatch(
        /milestone[^]*routes to `references\/milestone\.md`/,
      );
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
      'Workers:',
      'Share:',
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

    it('treats a build-cache hit on declared inputs a verify passed as the pass, in the orchestrator and the milestone reference', () => {
      const sentence =
        'A build-cache hit on declared inputs that a verify this session passed is the pass,';
      const unwrapped = (text: string): string => text.replace(/\s+/g, ' ');
      const milestone = unwrapped(
        readFileSync(
          join(root, '.claude/skills/orchestrate/references/milestone.md'),
          'utf8',
        ),
      );
      expect(unwrapped(orchestratorText)).toContain(sentence);
      expect(milestone).toContain(sentence);
      expect(milestone).toContain(
        "Delete the build cache only at the milestone's final step, or after a change to any script's declared inputs or dependencies",
      );
    });

    it('merges several orchestrators into one table with the Phase column first', () => {
      expect(nestedText).toMatch(
        /^\| Phase +\| Slice +\| Owns +\| State +\|$/m,
      );
      expect(nestedText).not.toMatch(/^\| Plan +\| Slice/m);
    });

    it('spawns the ready set by After and no longer bars sharing a plan workspace', () => {
      expect(nestedText).toContain('ready set');
      expect(nestedText).toContain('After');
      expect(nestedText).not.toContain('never share a plan workspace');
    });

    it('keeps ROADMAP.md with the main conversation and each sub-plan with its orchestrator', () => {
      const start = nestedText.indexOf('## Several orchestrators');
      const rest = nestedText.slice(start + 1);
      const next = rest.search(/^## /m);
      const section = next === -1 ? rest : rest.slice(0, next);

      expect(start, 'section present').not.toBe(-1);
      expect(section).toMatch(/`ROADMAP\.md` is the main conversation's/);
      expect(section).toMatch(/Each sub-plan is its\s+orchestrator's/);
    });

    it('names the 2,3 comma form and refuses a bad set before any spawn', () => {
      expect(nestedText).toContain('2,3');
      expect(nestedText).toMatch(/refuses it before any spawn/);
    });

    it('lists the comma form of phases in the invocation table', () => {
      expect(skillText).toMatch(/^\| `\/orchestrate [^`]*2,3` \|/m);
    });

    it('forbids the phase-orchestrator from writing ROADMAP.md', () => {
      expect(orchestratorText).toMatch(/Never\s+write\s+`ROADMAP\.md`/);
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

    it('holds a phase that cannot nest out of the spawn and runs it flat after the rest', () => {
      expect(nestedText).toMatch(/run the\s+held phase flat here/);
      expect(nestedText).toMatch(/orchestrate\.orchestratorTools/);
    });

    it('sizes each ready phase before the spawn and keeps a small one out of it', () => {
      expect(nestedText).toMatch(/Three causes put a phase here/);
      expect(nestedText).toMatch(
        /\*\*Size before the spawn\.\*\*[\s\S]*three slices or fewer and its steps write twelve files or\s+fewer/,
      );
      expect(nestedText).toMatch(/runs nested`, or ending `runs here`/);
    });

    it('lets a phase run in the main conversation hand a mechanical slice to a worker', () => {
      expect(nestedText).toMatch(
        /Dispatch a `task-worker` for a slice that is mechanical[\s\S]*"The brief" in `direct-dispatch\.md`/,
      );
    });

    it('waits for a finished notice by ending the turn, with one background fallback timer', () => {
      expect(nestedText).toMatch(
        /The notice is the wait\.[\s\S]*end the\s+turn with one line naming what is still running, and make no tool call/,
      );
      expect(nestedText).toMatch(
        /`sleep 1800` with\s+`run_in_background: true`, once per wait and never repeated/,
      );
      expect(nestedText).toMatch(
        /When the notice arrives first, stop\s+that command with `TaskStop` before any other call/,
      );
      expect(nestedText).not.toMatch(/foreground `sleep 20`/);
    });

    it('asks an orchestrator that dispatched no worker to say so', () => {
      expect(orchestratorText).toMatch(
        /`Workers dispatched: none` under `Rulings made`/,
      );
    });

    it('runs a phase that carries the live signal alone', () => {
      expect(nestedText).toMatch(
        /`live`(?: or `flat`)? on its `\*\*Signals:\*\*`\s+line, runs alone/,
      );
    });

    it("closes a sibling orchestrator's barrier on slice acceptances, with no package-wide verify", () => {
      expect(orchestratorText).toMatch(
        /reruns each slice's acceptance command with no typecheck/,
      );
      expect(nestedText).toMatch(/It runs no package-wide\s+verify/);
    });

    it('rechecks a wave on its acceptances and a typecheck, leaving the full verify to phase close', () => {
      const waveClose = skillText.slice(
        skillText.indexOf('## 7.'),
        skillText.indexOf('## 8.'),
      );
      const phaseClose = skillText.slice(
        skillText.indexOf('## 8.'),
        skillText.indexOf('## 9.'),
      );

      expect(waveClose).toMatch(
        /Rerun each slice's acceptance, then typecheck the packages the wave\s+touched/,
      );
      expect(waveClose).not.toMatch(/\/verify-changed/);
      expect(phaseClose).toMatch(/run `\/verify-changed` if installed/);
      expect(orchestratorText).toMatch(
        /`Siblings:` is `none`, §7 step 3 reruns each slice's acceptance and typechecks/,
      );
    });

    describe('a phase close and the milestone step barrier', () => {
      const unwrapped = (text: string): string => text.replace(/\s+/g, ' ');
      let phaseClose: string;
      let milestone: string;

      beforeEach(() => {
        phaseClose = unwrapped(
          skillText.slice(
            skillText.indexOf('## 8.'),
            skillText.indexOf('## 9.'),
          ),
        );
        milestone = unwrapped(
          readFileSync(
            join(root, '.claude/skills/orchestrate/references/milestone.md'),
            'utf8',
          ),
        );
      });

      it('skips /verify-changed at a milestone item close whatever its Siblings line reads', () => {
        expect(phaseClose).toContain(
          'A milestone item skips it, per `references/milestone.md`.',
        );
        expect(unwrapped(orchestratorText)).toContain(
          'Its §8 runs no `/verify-changed`, whatever its `Siblings:` line reads,',
        );
        expect(milestone).toContain(
          "An item's §8 runs no `/verify-changed`, whatever its `Siblings:` line reads, nested or flat.",
        );
      });

      it('keeps /verify-changed at §8 for a phase outside a milestone whose Siblings is none', () => {
        expect(phaseClose).toContain(
          'All waves done → run `/verify-changed` if installed',
        );
        expect(unwrapped(orchestratorText)).toContain(
          '`/verify-changed` runs once, at §8, unless you run a milestone item.',
        );
      });

      it('names the Close as the step barrier’s one full-suite run and scopes each member Verify', () => {
        expect(milestone).toContain(
          "The step's `Close` is its one full-suite run, and each member's `Verify` is scoped to that member's packages.",
        );
      });
    });

    it('lets a verify already running finish rather than killing it', () => {
      expect(orchestratorText).toMatch(/never try to kill it/);
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

    it('pins the wave ceiling across the skill, references, agent, and script install', () => {
      const slicing = readFileSync(
        join(root, '.claude/skills/orchestrate/references/slicing.md'),
        'utf8',
      );

      expect(slicing).toContain('## Wave ceiling');
      expect(slicing).toContain('wave-ceiling.mjs');
      expect(skillText).toContain('Wave ceiling');
      expect(orchestratorText).toContain('Workers:');
      expect(
        existsSync(join(root, '.claude/scripts/wave-ceiling.mjs')),
        'wave-ceiling.mjs installed',
      ).toBe(true);
      expect(Object.keys(manifestOf(root).files)).toContain(
        '.claude/scripts/wave-ceiling.mjs',
      );
    });

    it('installs the direct-dispatch reference with its worker count read from wave-ceiling.mjs', () => {
      const direct = readFileSync(
        join(root, '.claude/skills/orchestrate/references/direct-dispatch.md'),
        'utf8',
      );
      const atOnce = direct
        .split('## How many go out at once')[1]
        ?.split('\n## ')[0];

      expect(Object.keys(manifestOf(root).files)).toContain(
        '.claude/skills/orchestrate/references/direct-dispatch.md',
      );
      expect(atOnce).toContain('`node .claude/scripts/wave-ceiling.mjs`');
      expect(atOnce).toContain('`ceiling`');
      expect(atOnce).toContain('`share`');
      expect(atOnce).not.toMatch(/\d/);
    });

    it('prefixes the brief template acceptance command with the share', () => {
      expect(skillText).toContain(
        '> Acceptance: `<share prefix> <command(s), scoped to your owned paths>`',
      );
    });

    it('names the share prefix variables in the slicing wave-ceiling step', () => {
      const slicing = readFileSync(
        join(root, '.claude/skills/orchestrate/references/slicing.md'),
        'utf8',
      );

      expect(slicing).toContain(
        '`VITEST_MAX_WORKERS=<share>`, plus each variable a `.claude/extensions/*.json` fragment lists',
      );
    });

    it('tells the phase-orchestrator where its share comes from', () => {
      expect(orchestratorText.replace(/\s+/g, ' ')).toContain(
        '`Share:` is the share `references/slicing.md` "Wave ceiling" prefixes onto each acceptance command, and absent it you read `share` from that same call.',
      );
    });

    it('tells the task-worker to keep an environment prefix as given', () => {
      expect(agentText.replace(/\s+/g, ' ')).toContain(
        'never strip it, and never add one your brief did not give.',
      );
    });

    it('installs the closeout-worker agent and closeout.mjs', () => {
      const text = readFileSync(
        join(root, '.claude/agents/closeout-worker.md'),
        'utf8',
      );
      const toolsLine = text.match(/^tools: .*$/m)?.[0] ?? '';

      expect(text).toMatch(/^model: sonnet$/m);
      expect(toolsLine.slice('tools: '.length).split(', ')).toEqual([
        'Read',
        'Edit',
        'Write',
        'Grep',
        'Glob',
        'Bash',
      ]);
      expect(
        existsSync(join(root, '.claude/scripts/closeout.mjs')),
        'closeout.mjs installed',
      ).toBe(true);
      expect(Object.keys(manifestOf(root).files)).toContain(
        '.claude/scripts/closeout.mjs',
      );
    });

    it('adds the /orchestrate carve-out against implementation subagents to the file CLAUDE.md imports', () => {
      const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
      const sections = readFileSync(
        join(root, '.claude/houserules.md'),
        'utf8',
      );
      expect(claudeMd).toMatch(/^@\.claude\/houserules\.md$/m);
      expect(sections).toMatch(/\/orchestrate/);
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

    it('tells the orchestrator to pick model and effort per slice and names no effort variant', () => {
      expect(skillText).toMatch(
        /plus the `model` and `effort` its shape earns/,
      );
      expect(skillText).not.toMatch(/model: sonnet/);
      expect(skillText).not.toMatch(/task-worker-(low|high|xhigh)/);
    });

    it('documents orchestrate.workerTools in the installed SKILL.md', () => {
      expect(skillText).toMatch(/orchestrate\.workerTools/);
    });

    it('tells the worker to report a missing required tool under Deviations', () => {
      expect(agentText).toMatch(/tool you do not have/);
    });
  });

  describe('selected alone', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('npm-single', { modules: 'orchestrate' });
    });

    it('installs the orchestrate skill', () => {
      expect(
        existsSync(join(root, '.claude/skills/orchestrate/SKILL.md')),
        'orchestrate skill installed',
      ).toBe(true);
    });

    it('installs the plans module with it', () => {
      expect(
        existsSync(join(root, '.claude/skills/plan-project/SKILL.md')),
        'plan-project skill installed',
      ).toBe(true);
    });

    it('creates the plans workspace', () => {
      expect(
        existsSync(join(root, '.claude/plans/.gitignore')),
        'plans workspace created',
      ).toBe(true);
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

describe('task-worker source', () => {
  it('requires scratch files under a path carrying the slice id', () => {
    expect(SOURCE).toContain('goes under `<scratchpad>/<slice id>/`');
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

describe('orchestrate plan(), removal-check', () => {
  it('installs removal-check.mjs under .claude/scripts', () => {
    const dests = plan({} as Ctx, baseAnswers()).map((action) =>
      'dest' in action ? action.dest : '',
    );

    expect(dests).toContain('.claude/scripts/removal-check.mjs');
  });
});

describe('orchestrate plan(), diff-size', () => {
  it('installs diff-size.mjs under .claude/scripts', () => {
    const dests = plan({} as Ctx, baseAnswers()).map((action) =>
      'dest' in action ? action.dest : '',
    );

    expect(dests).toContain('.claude/scripts/diff-size.mjs');
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

  it('writes the agent with orchestrate.orchestratorTools appended and no longer copies it', () => {
    const ctx = {
      claude: {
        houseConfig: {
          orchestrate: { orchestratorTools: ['mcp__chrome-devtools'] },
        },
      },
    } as Ctx;

    const actions = plan(ctx, baseAnswers());

    const write = actions.find(
      (action) =>
        action.kind === 'write' &&
        action.dest === '.claude/agents/phase-orchestrator.md',
    );
    expect((write as { content: string } | undefined)?.content).toMatch(
      /^tools: Read, Edit, Write, Grep, Glob, Bash, Agent, SendMessage, Skill, mcp__chrome-devtools$/m,
    );
    expect(
      actions.some(
        (action) =>
          action.kind === 'copy' &&
          action.dest === '.claude/agents/phase-orchestrator.md',
      ),
      'no longer copied',
    ).toBe(false);
  });

  it('advises that each phase runs one layer down by default and --flat keeps it here', () => {
    const answers = { ...baseAnswers(), moduleIds: ['orchestrate', 'plans'] };
    const advice = plan({} as Ctx, answers).flatMap((action) =>
      action.kind === 'advise' ? [action.text] : [],
    );

    expect(advice.join('\n')).toMatch(
      /By default it hands each phase to a phase-orchestrator[^]*--flat keeps the slicing/,
    );
  });

  it('advises the milestone form', () => {
    const answers = { ...baseAnswers(), moduleIds: ['orchestrate', 'plans'] };
    const advice = plan({} as Ctx, answers).flatMap((action) =>
      action.kind === 'advise' ? [action.text] : [],
    );

    expect(advice.join('\n')).toContain('/orchestrate <milestone>');
  });

  it('hints the one-layer-down default', () => {
    expect(hint()).toMatch(/phase-orchestrator/);
  });

  it('names no model tier in the hint, any reason, or the advise text', () => {
    const answers = {
      ...baseAnswers({ moduleOptions: { orchestrate: ['research'] } }),
      moduleIds: ['orchestrate', 'plans'],
    };
    const strings = plan({} as Ctx, answers).flatMap((action) => {
      if (action.kind === 'advise') return [action.text];
      return 'reason' in action ? [action.reason] : [];
    });

    expect(strings.length).toBeGreaterThan(1);
    for (const text of [hint(), ...strings]) {
      expect(text).not.toMatch(/\b(sonnet|opus|haiku|fable)\b/i);
    }
  });
});

describe('orchestrate plan(), direct-dispatch reference', () => {
  it('copies the reference in a default install', () => {
    const actions = plan({} as Ctx, baseAnswers());

    expect(
      actions.some(
        (action) =>
          action.kind === 'copy' &&
          action.dest ===
            '.claude/skills/orchestrate/references/direct-dispatch.md',
      ),
    ).toBe(true);
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
  function tempRootWithAgent(toolsLine: string, name = 'task-worker'): string {
    const root = mkdtempSync(join(tmpdir(), 'orchestrate-check-'));
    mkdirSync(join(root, '.claude', 'agents'), { recursive: true });
    writeFileSync(
      join(root, '.claude', 'agents', `${name}.md`),
      `---\nname: ${name}\n${toolsLine}\nmodel: sonnet\n---\nbody\n`,
    );
    return root;
  }

  it('warns when phase-orchestrator lacks a tool orchestrate.orchestratorTools names', () => {
    const root = tempRootWithAgent('tools: Read, Agent', 'phase-orchestrator');
    const ctx = {
      root,
      claude: {
        agents: ['phase-orchestrator.md'],
        houseConfig: {
          orchestrate: { orchestratorTools: ['mcp__chrome-devtools'] },
        },
      },
    } as Ctx;

    const result = check(ctx);

    expect(result.findings).toEqual([
      {
        level: 'WARN',
        msg: 'agent phase-orchestrator.md is missing mcp__chrome-devtools from its tools: line — run npx houserules update to refresh it',
      },
    ]);
  });

  it('does not hold task-worker to orchestrate.orchestratorTools', () => {
    const root = tempRootWithAgent('tools: Read, Edit, Write');
    const ctx = {
      root,
      claude: {
        agents: ['task-worker.md'],
        houseConfig: {
          orchestrate: { orchestratorTools: ['mcp__chrome-devtools'] },
        },
      },
    } as Ctx;

    const result = check(ctx);

    expect(result.findings).toEqual([]);
  });

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
