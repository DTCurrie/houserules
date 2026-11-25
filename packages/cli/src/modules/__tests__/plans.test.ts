import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useInstalledRepo } from '#test/repo';
import { runCli } from '#test/run';
import { manifestOf } from '#test/installed-tree';
import { hint, plan } from '../plans.js';

describe('plans', () => {
  describe('when enabled', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', { modules: 'plans' });
    });

    it('ships the /blast-radius worked-example skill', () => {
      const skillPath = join(root, '.claude/skills/blast-radius/SKILL.md');
      expect(existsSync(skillPath), 'blast-radius skill installed').toBe(true);
      const text = readFileSync(skillPath, 'utf8');
      expect(text).toMatch(/\.claude\/plans\/blast-radius-/);
      expect(text).toMatch(/\.claude\/plans\/<plan>\/blast-radius-/);
      expect(text).toMatch(/disclaimer|Snapshot at commit/i);
      expect(text).toMatch(/Completeness self-audit/);
    });

    it('ships a sonnet blast-radius-mapper agent with no edit tools', () => {
      const agentText = readFileSync(
        join(root, '.claude/agents/blast-radius-mapper.md'),
        'utf8',
      );
      expect(agentText).toMatch(/model: sonnet/);
      expect(agentText).toMatch(/^tools: Read, Grep, Glob, Bash$/m);
    });

    it('ships a sonnet plan-reviewer agent with no edit tools', () => {
      const agentText = readFileSync(
        join(root, '.claude/agents/plan-reviewer.md'),
        'utf8',
      );
      expect(agentText).toMatch(/model: sonnet/);
      expect(agentText).toMatch(/^tools: .*$/m);
      expect(agentText).not.toMatch(/^tools:.*\b(Write|Edit)\b/m);
    });

    it('installs the /plan-project skill without wiring a hook', () => {
      expect(
        existsSync(join(root, '.claude/skills/plan-project/SKILL.md')),
        'plan-project skill installed',
      ).toBe(true);
      const manifest = manifestOf(root);
      expect(manifest.modules).toContain('plans');
    });

    it('templates a phase doc with a Reference section for the spec its work must conform to', () => {
      const text = readFileSync(
        join(root, '.claude/skills/plan-project/SKILL.md'),
        'utf8',
      );
      expect(text).toMatch(/## Reference\n\n<[^>]*"none"[^>]*>/);
    });

    it('templates a phase doc with a Review Focus section between Steps and Notes', () => {
      const text = readFileSync(
        join(root, '.claude/skills/plan-project/SKILL.md'),
        'utf8',
      );
      expect(text).toMatch(
        /## Steps\n[\s\S]*\n## Review Focus\n[\s\S]*\n## Notes & decisions\n/,
      );
    });

    it('templates a phase doc with a Standing rulings list between Reference and Steps', () => {
      const text = readFileSync(
        join(root, '.claude/skills/plan-project/SKILL.md'),
        'utf8',
      );
      expect(text).toMatch(
        /## Reference\n[\s\S]*\n## Standing rulings\n\n1\. <[^>]*owner decision[^>]*>\n\n## Steps\n/,
      );
    });

    it('describes Notes & decisions as a log of how a decision was reached', () => {
      const text = readFileSync(
        join(root, '.claude/skills/plan-project/SKILL.md'),
        'utf8',
      );
      expect(text).toMatch(
        /## Notes & decisions\n\n<A log of how a decision was reached:[^>]*The decision\s+itself lands in `## Steps` or `## Standing rulings`\.>/,
      );
    });

    it('forbids a ruling that leaves its step unedited, with the three excuses answered', () => {
      const text = readFileSync(
        join(root, '.claude/skills/plan-project/SKILL.md'),
        'utf8',
      );
      expect(text).toContain(
        '**A decision that changes a step edits that step in the same edit.**',
      );
      expect(text).toMatch(/log the step's old text\s+in the note/);
      expect(text).toContain(
        'The step is done when it reads as the ruling says.',
      );
      expect(text).toMatch(
        /"The note records it, so the plan is updated\." The steps are what the next reader builds from\. A\s+note below them is not an update\./,
      );
      expect(text).toContain(
        '"Rewriting the steps loses history." Edit the step and log the old text in the note.',
      );
      expect(text).toContain(
        '"The step is only slightly out of date." A reader cannot tell which steps are slightly out of date.',
      );
    });

    it('templates the Domain line and the After segment', () => {
      const text = readFileSync(
        join(root, '.claude/skills/plan-project/SKILL.md'),
        'utf8',
      );
      expect(text).toContain('**Domain:**');
      expect(text).toMatch(/\[sub-plan\]\(phase-3-<slug>\.md\) · After: none/);
    });

    it('tells the planner to mark independent phases After: none', () => {
      const text = readFileSync(
        join(root, '.claude/skills/plan-project/SKILL.md'),
        'utf8',
      );
      expect(text).toMatch(
        /Read independence off the finished cut[\s\S]*After: none/,
      );
    });

    it('has the plan-reviewer check Domain roots', () => {
      const agentText = readFileSync(
        join(root, '.claude/agents/plan-reviewer.md'),
        'utf8',
      );
      expect(agentText).toContain('**Domain:**');
    });

    it('installs the milestone reference the plan-project skill defers to', () => {
      expect(
        existsSync(
          join(root, '.claude/skills/plan-project/references/milestone.md'),
        ),
        'milestone reference installed',
      ).toBe(true);
    });

    it('installs the closeout reference the plan-project skill defers to', () => {
      expect(
        existsSync(
          join(root, '.claude/skills/plan-project/references/closeout.md'),
        ),
        'closeout reference installed',
      ).toBe(true);
    });

    it('has the plan-reviewer read a milestone', () => {
      const agentText = readFileSync(
        join(root, '.claude/agents/plan-reviewer.md'),
        'utf8',
      );
      expect(agentText).toContain('`MILESTONE.md`');
    });

    it('has the plan-reviewer take a Level line that defaults to plan', () => {
      const agentText = readFileSync(
        join(root, '.claude/agents/plan-reviewer.md'),
        'utf8',
      );
      expect(agentText).toMatch(
        /Its values are `milestone`, `plan`, and `phase`\. An absent line means\s+`plan`\./,
      );
      expect(agentText).toMatch(/^- `phase`: the brief names one sub-plan/m);
    });

    it('has the plan-reviewer tag each item as a fact or a decision with no target count', () => {
      const agentText = readFileSync(
        join(root, '.claude/agents/plan-reviewer.md'),
        'utf8',
      );
      expect(agentText).toMatch(/^1\. \[fact\] /m);
      expect(agentText).toMatch(
        /^2\. \[decision\] .*Issue: .*Question: <[^>]*question mark>$/m,
      );
      expect(agentText).toContain('There is no target count');
      expect(agentText).not.toContain('Between 0 and 10');
    });

    it('has the planner work the reviewer list instead of relaying it raw', () => {
      const skill = readFileSync(
        join(root, '.claude/skills/plan-project/SKILL.md'),
        'utf8',
      );
      expect(skill).toContain('Never relay the list raw.');
      expect(skill).toMatch(
        /the issue, the question as a\s+sentence ending in a question mark, and your recommendation with its reason/,
      );
      expect(skill).not.toMatch(/Do not edit the plan to\s+answer a question/);
    });

    it('puts a Level line in every plan-reviewer dispatch the skill writes', () => {
      const docs = [
        '.claude/skills/plan-project/SKILL.md',
        '.claude/skills/plan-project/references/milestone.md',
      ];
      const dispatches = docs.flatMap((doc) =>
        readFileSync(join(root, doc), 'utf8')
          .split(/\n\s*\n/)
          .filter((paragraph) =>
            /Dispatch[^.]*`plan-reviewer`/i.test(paragraph),
          )
          .map((paragraph) => ({ doc, paragraph })),
      );
      expect(dispatches.map(({ doc }) => doc)).toEqual(docs);
      expect(
        dispatches.map(
          ({ paragraph }) => paragraph.match(/`Level: (\w+)`/)?.[1],
        ),
      ).toEqual(['plan', 'milestone']);
    });

    it('hands a milestone off in-context when the orchestrate module is absent', () => {
      const text = readFileSync(
        join(root, '.claude/skills/plan-project/SKILL.md'),
        'utf8',
      );
      expect(
        existsSync(join(root, '.claude/skills/orchestrate/SKILL.md')),
        'orchestrate skill absent',
      ).toBe(false);
      expect(text).toMatch(
        /`\/orchestrate <milestone>` as the next command \(needs the\s+`orchestrate` module\)\. Without that module, the next command is the user asking you to take the\s+first item in-context/,
      );
    });

    it('self-gitignores its plan workspace while keeping the .gitignore itself tracked', () => {
      const ignore = readFileSync(
        join(root, '.claude/plans/.gitignore'),
        'utf8',
      );
      expect(ignore).toMatch(/^\*$/m);
      expect(ignore).toMatch(/^!\.gitignore$/m);
    });

    it('adds a trigger routing oversized work to /plan-project in the file CLAUDE.md imports', () => {
      const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
      const sections = readFileSync(
        join(root, '.claude/houserules.md'),
        'utf8',
      );
      expect(claudeMd).toMatch(/^@\.claude\/houserules\.md$/m);
      expect(sections).toMatch(/\/plan-project\b/);
      expect(sections).toMatch(/too big to hold in one plan/);
    });

    it('does not add a nested plans/CLAUDE.md, since that would never auto-load', () => {
      expect(
        existsSync(join(root, '.claude/plans/CLAUDE.md')),
        'no nested plans/CLAUDE.md',
      ).toBe(false);
    });

    it('passes doctor validation', () => {
      expect(runCli(['doctor', root]).status).toBe(0);
    });
  });

  describe('enabled together with the orchestrate module', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo', {
        modules: 'plans,orchestrate',
      });
    });

    function installed(path: string): string {
      return readFileSync(
        join(root, '.claude/skills/orchestrate', path),
        'utf8',
      );
    }

    it('sends the orchestrator to slicing.md before a slice is drawn', () => {
      expect(installed('SKILL.md')).toContain(
        'Read `references/slicing.md` before you draw a slice.',
      );
    });

    it('reconciles the steps with the rulings and later notes once, before any slice', () => {
      const slicing = installed('references/slicing.md');

      expect(slicing).toContain(
        '## Reconcile the steps with the rulings, before any slice',
      );
      expect(slicing).toMatch(
        /Run this once, at the start of a run, before you\s+draw a slice:/,
      );
      expect(slicing).toMatch(
        /On a step that a ruling or a later note contradicts, stop and report the contradiction to the\s+user: the step, the ruling or note, and what each says\. Never pick one\./,
      );
      expect(slicing).toMatch(
        /It is done when each ruling and each note dated after the phase's last run has been read against the\s+steps/,
      );
    });

    it('never takes a brief Constraints line from the notes', () => {
      expect(installed('references/slicing.md')).toMatch(
        /The notes are never the source of a brief's `Constraints:`\. That line comes from the phase's\s+`## Standing rulings` and `PLAN\.md`'s Approach\./,
      );
    });

    it("fills the brief's Constraints line from the Standing rulings and PLAN.md's Approach", () => {
      const constraints =
        installed('SKILL.md').match(/^> Constraints: .*$/m)?.[0];

      expect(constraints).toBe(
        "> Constraints: `<the phase's Standing rulings and PLAN.md's Approach this slice must respect>`.",
      );
    });

    it('judges a slice report against the Standing rulings', () => {
      expect(installed('references/review-patterns.md')).toMatch(
        /\*\*Does it hold to the phase's `## Standing rulings`\?\*\* Judge the report against that list as well\s+as the brief/,
      );
    });

    it('lists each departure from a Standing ruling in the phase-close report', () => {
      expect(installed('references/closing.md')).toMatch(
        /The phase-close report lists each departure from a ruling under `Departures from Standing rulings`/,
      );
    });

    it('stops a wave close past two thirds of the diff budget with one recommendation', () => {
      expect(installed('references/closing.md')).toMatch(
        /more than two thirds of its limit and the sub-plan has an unticked step[\s\S]*return one recommendation,\s+never a menu/,
      );
    });

    it('measures a phase with a Domain by its own roots', () => {
      expect(installed('references/closing.md')).toMatch(
        /carries a `\*\*Domain:\*\*` line, pass its roots as `--paths`/,
      );
    });
  });

  describe('by default', () => {
    let root: string;

    beforeEach(() => {
      root = useInstalledRepo('pnpm-monorepo');
    });

    it('is not enabled', () => {
      const manifest = manifestOf(root);
      expect(manifest.modules).not.toContain('plans');
    });

    it('installs no skill, agent, or workspace', () => {
      expect(
        existsSync(join(root, '.claude/skills/plan-project/SKILL.md')),
        'plan-project skill not installed',
      ).toBe(false);
      expect(
        existsSync(join(root, '.claude/agents/blast-radius-mapper.md')),
        'blast-radius-mapper agent not installed',
      ).toBe(false);
      expect(
        existsSync(join(root, '.claude/agents/plan-reviewer.md')),
        'plan-reviewer agent not installed',
      ).toBe(false);
      expect(
        existsSync(join(root, '.claude/plans/.gitignore')),
        'plans workspace not created',
      ).toBe(false);
    });

    it('installs no milestone reference', () => {
      expect(
        existsSync(
          join(root, '.claude/skills/plan-project/references/milestone.md'),
        ),
        'milestone reference not installed',
      ).toBe(false);
    });

    it('adds no CLAUDE.md pointer', () => {
      const claudeMd = readFileSync(join(root, 'CLAUDE.md'), 'utf8');
      expect(claudeMd).not.toContain('/plan-project');
      expect(claudeMd).not.toContain('.claude/plans/');
    });
  });

  it('names no model tier in the hint or any action reason', () => {
    const reasons = plan().flatMap((action) =>
      'reason' in action ? [action.reason] : [],
    );

    expect(reasons.length).toBeGreaterThan(1);
    for (const text of [hint(), ...reasons]) {
      expect(text).not.toMatch(/\b(sonnet|opus|haiku|fable)\b/i);
    }
  });
});
