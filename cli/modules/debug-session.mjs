// debug-session module (claude-kit CLI): OPT-IN hypothesis-driven debugging.
// Ships the /debug-session skill (the interactive loop: hypotheses → tagged trace
// logging under .claude/debug/ → jq → confirm/reject → remove ALL instrumentation),
// a self-gitignored throwaway-log dir, an off-context debugger agent template, and a
// SessionStart backstop that flags an open session or leftover instrumentation.
//
// The CLAUDE.md template already carries the tracing *prose*; this is the enforced
// loop + log format + cleanup-tracking the prose only gestures at.

import { hookFragment, script, skill, template } from './shared.mjs';

export const id = 'debug-session';
export const title = 'Hypothesis-driven debug session (/debug-session)';
export const group = 'optional';

export function hint() {
  return 'structured trace-log loop under .claude/debug/ with complete instrumentation cleanup';
}

export function defaultEnabled() {
  return false;
}

export function plan() {
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
    // Throwaway trace logs must never enter a commit. A directory-local .gitignore
    // (like .claude/kit-templates/) keeps them out without touching the repo's
    // .gitignore; the .gitignore itself stays tracked so the intent travels.
    {
      kind: 'write',
      dest: '.claude/debug/.gitignore',
      content: [
        '# Throwaway trace logs written by the /debug-session skill. Not for commit.',
        '# The directory stays so instrumentation always has somewhere to append.',
        '*',
        '!.gitignore',
        '',
      ].join('\n'),
      module: id,
      reason:
        'trace logs are throwaway; self-gitignored (repo .gitignore untouched)',
    },
    {
      kind: 'merge-settings',
      module: id,
      fragment: hookFragment('SessionStart', null, 'debug-session-check.mjs'),
    },
    {
      kind: 'advise',
      text: 'Debug sessions: run /debug-session "<bug>" for the hypothesis→trace→cleanup loop. For an off-context debugger, instantiate .claude/kit-templates/agents/debugger.agent.md.template per target.',
      module: id,
    },
  ];
}
