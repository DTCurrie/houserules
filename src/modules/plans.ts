// plans module (claude-kit CLI): OPT-IN phased-implementation planning.
// Ships the /plan-project skill, which persists a large/multi-phase implementation to a
// gitignored `.claude/plans/<name>/` project workspace (PLAN overview + a living
// ROADMAP + one sub-plan per phase) and keeps ROADMAP status current in place so a
// returning session greps status instead of re-deriving scope from the transcript.
//
// Deliberately script-free: the value is the doc structure + status-in-place
// discipline, not tooling. The `/plan-project` pointer lives in the root CLAUDE.md (see
// render.mjs plansSection) because a nested `.claude/plans/CLAUDE.md` would never
// load when it's needed — plans are pull-only.

import type { Action, ModuleGroup } from '../types.js';
import { skill } from './shared.js';

export const id = 'plans';
export const title = 'Phased-implementation planning (/plan-project)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'persist large/multi-phase work to .claude/plans/<name>/ (PLAN + living ROADMAP + per-phase sub-plans)';
}

export function defaultEnabled(): boolean {
  return false;
}

export function plan(): Action[] {
  return [
    skill(
      id,
      'plan-project',
      'the /plan-project scaffold + status-in-place ROADMAP discipline',
    ),
    // /blast-radius shares the .claude/plans/ home (its dated impact maps land there,
    // gitignored) — a worked example of read-only fan-out → archived artifact.
    skill(
      id,
      'blast-radius',
      'fan out read-only explorers once → archive a dated impact map under .claude/plans/',
    ),
    // Plan workspaces are living project state, not commit artifacts, and churn every
    // phase. A directory-local .gitignore (like .claude/debug/) keeps them out of
    // commits without touching the repo's .gitignore; the .gitignore itself stays
    // tracked so the intent travels. Users who want to share a plan force-add it.
    {
      kind: 'write',
      dest: '.claude/plans/.gitignore',
      content: [
        '# Plan workspaces written by the /plan-project skill (PLAN.md, ROADMAP.md, phase sub-plans).',
        '# Gitignored by default: living project state, high-churn, local to your working copy.',
        '# To share a plan, force-add it (git add -f .claude/plans/<name>/) or delete this file.',
        '*',
        '!.gitignore',
        '',
      ].join('\n'),
      module: id,
      reason:
        'plan workspaces are living project state; self-gitignored (repo .gitignore untouched)',
    },
    {
      kind: 'advise',
      text: 'Planning: run /plan-project "<what to build>" for a large/multi-phase implementation — it scaffolds .claude/plans/<name>/ and tracks ROADMAP status in place so resuming is a grep, not a re-derivation. Run /blast-radius "<change>" to archive a dated impact map (also under .claude/plans/) before a wide change.',
      module: id,
    },
  ];
}
