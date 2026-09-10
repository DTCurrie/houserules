import type { Action, ModuleGroup } from '@houserules/api';
import { agent } from './copy-actions.js';

export const id = 'research';
export const title = 'Planned research & synthesis agents';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'off-context agents for planned phases: research-spike, research-synth, refactor-planner (pairs with plans)';
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
      'refactor-planner',
      'reconciles a set of audit reports into one sliced refactor plan plus an architecture document',
    ),
    {
      kind: 'advise',
      text: "Research: a planner's research phase can dispatch one research-spike per scoped question set and one research-synth to merge the reports, with outputs landing inside the plan workspace. Audit reports from a sweep or review phase feed refactor-planner, whose slices feed /orchestrate.",
      module: id,
    },
  ];
}
