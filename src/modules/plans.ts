import type { Action } from '../actions.js';
import type { ModuleGroup } from '../module-def.js';
import { skill } from './copy-actions.js';

export const id = 'plans';
export const title = 'Phased-implementation planning (/plan-project)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'persist large/multi-phase work to .claude/plans/<name>/ (PLAN + living ROADMAP + per-phase sub-plans)';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * Persists a large, multi-phase implementation to a gitignored `.claude/plans/<name>/`
 * workspace: a PLAN overview, a living ROADMAP, and one sub-plan per phase. ROADMAP
 * status stays current in place, so a returning session greps status instead of
 * re-deriving scope from the transcript.
 *
 * Script-free, because the value is the doc structure and status-in-place discipline. The
 * pointer lives in the root CLAUDE.md rather than a nested `.claude/plans/CLAUDE.md`,
 * which would never load when it is needed.
 */
export function plan(): Action[] {
  return [
    skill(
      id,
      'plan-project',
      'the /plan-project scaffold + status-in-place ROADMAP discipline',
    ),
    // /blast-radius shares the .claude/plans/ home, where its dated impact maps land.
    skill(
      id,
      'blast-radius',
      'fan out read-only explorers once → archive a dated impact map under .claude/plans/',
    ),
    // Living project state, not commit artifacts, and it churns every phase. A
    // directory-local .gitignore keeps it out of commits without touching the repo's own.
    // Sharing a plan means force-adding it.
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
      text: 'Planning: run /plan-project "<what to build>" for a large/multi-phase implementation. It scaffolds .claude/plans/<name>/, tracks ROADMAP status in place so resuming is a grep, and then stops. Implementing a phase is a separate step. Run /blast-radius "<change>" to archive a dated impact map (also under .claude/plans/) before a wide change.',
      module: id,
    },
  ];
}
