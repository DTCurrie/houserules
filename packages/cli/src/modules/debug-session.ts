import type { Action, ModuleGroup } from '@houserules/api';
import {
  script,
  selfGitignoreAction,
  skill,
  template,
} from './copy-actions.js';
import { hookFragment } from '@houserules/api';

export const id = 'debug-session';
export const title = 'Hypothesis-driven debug session (/debug-session)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'structured trace-log loop under .claude/debug/ with complete instrumentation cleanup';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * Ships hypothesis-driven debugging: the skill's loop from hypotheses to tagged trace
 * logs under `.claude/debug/` to jq to confirm or reject to removing all instrumentation,
 * a self-gitignored log directory, a debugger agent template, and a SessionStart backstop
 * that flags an open session or leftover instrumentation.
 *
 * The CLAUDE.md template already carries the tracing prose. This is the enforced loop,
 * log format, and cleanup tracking the prose only gestures at.
 */
export function plan(): Action[] {
  return [
    skill(
      id,
      'debug-session',
      'the /debug-session hypothesis→trace→cleanup loop',
    ),
    script(
      id,
      'debug-session-check.mjs',
      'SessionStart hook: flag an open debug session or orphaned instrumentation',
    ),
    template(
      id,
      'agents/debugger.agent.md.template',
      'off-context debugger agent pattern',
    ),
    // Throwaway trace logs must never enter a commit. A directory-local .gitignore keeps
    // them out without touching the repo's own, and stays tracked so the intent travels.
    selfGitignoreAction(
      id,
      '.claude/debug/.gitignore',
      [
        '# Throwaway trace logs written by the /debug-session skill. Not for commit.',
        '# The directory stays so instrumentation always has somewhere to append.',
      ],
      'trace logs are throwaway; self-gitignored (repo .gitignore untouched)',
    ),
    {
      kind: 'merge-settings',
      module: id,
      fragment: hookFragment('SessionStart', null, 'debug-session-check.mjs'),
    },
    {
      kind: 'advise',
      text: 'Debug sessions: run /debug-session "<bug>" for the hypothesis→trace→cleanup loop. For an off-context debugger, instantiate .claude/templates/agents/debugger.agent.md.template per target.',
      module: id,
    },
  ];
}
