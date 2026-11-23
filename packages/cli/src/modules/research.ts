import type { Action, ModuleGroup, ModuleRequirement } from '@houserules/api';
import { agent, lib, script } from './copy-actions.js';
import { payloadPath } from '../paths.js';

export const id = 'research';
export const title = 'Planned research & synthesis agents';
export const group: ModuleGroup = 'optional';

// Modules this one's shipped prose hands off to when installed, and skips or falls back from
// when not. Read by the root `verify:module-references` check.
export const uses: ModuleRequirement[] = [
  { id: 'prose-voice', package: '@houserules/plugin-prose' },
  { id: 'orchestrate' },
];

export function hint(): string {
  return 'off-context agents for planned phases: research-orchestrator, research-spike, research-synth, refactor-planner (pairs with plans)';
}

export function defaultEnabled(): boolean {
  return false;
}

export function plan(): Action[] {
  return [
    agent(
      id,
      'research-spike',
      'answers one scoped research brief and writes one report, fetching primary sources rather than recalling them',
    ),
    agent(
      id,
      'research-synth',
      'reconciles a set of raw reports into one cited reference document, flagging contradictions',
    ),
    agent(
      id,
      'research-orchestrator',
      'runs research rounds over one domain, spawning one research-spike per thread and opening threads from leads up to a cap',
    ),
    agent(
      id,
      'refactor-planner',
      'reconciles a set of audit reports into one sliced refactor plan plus an architecture document',
    ),
    {
      kind: 'copy',
      src: payloadPath('agents', 'findings-format.md'),
      dest: '.claude/reference/findings-format.md',
      module: id,
      reason:
        'the finding format research reports are written in and checked against',
    },
    script(
      id,
      'check-findings.mjs',
      'checks findings reports and a synthesis against the finding format',
    ),
    script(
      id,
      'scaffold-synthesis.mjs',
      'lays out a synthesis skeleton with one table row per finding id',
    ),
    // The turndown loader `fetch-batch.mjs` and `check-findings.mjs` share.
    lib(id, 'html-markdown.mjs'),
    script(
      id,
      'fetch-batch.mjs',
      "fetches a round's URLs in one call and writes each page to a file",
    ),
    {
      kind: 'copy',
      src: payloadPath(
        'skills',
        'plan-project',
        'references',
        'research-layout.md',
      ),
      dest: '.claude/skills/plan-project/references/research-layout.md',
      module: id,
      reason: 'the domain, topic, and thread tree research is laid out in',
    },
    {
      kind: 'advise',
      text: "Research: a planner's research phase can dispatch one research-orchestrator, which runs one research-spike per thread over rounds and one research-synth to merge the reports, with outputs landing inside the plan workspace. Audit reports from a sweep or review phase feed refactor-planner, whose slices feed /orchestrate.",
      module: id,
    },
  ];
}
