// code-comments module (claude-kit CLI): OPT-IN comment-discipline rule.
// Ships .claude/rules/code-comments.md — default to no comment; comment only for a
// divergence from convention or non-obvious domain logic; 200-char cap; never
// narrate code or explain the diff.
//
// Delivered as a NATIVE path-scoped rule (frontmatter `paths:` globs, verified
// against Claude Code 2.1.220): the body loads only when a matching source file is
// in the working set, so it costs nothing on the always-loaded surface
// (CONVENTIONS §1 — the on-demand tier, without a CLAUDE.md pointer to maintain).
// Script-free and hook-free: the platform does the conditional loading.

import { rule } from './shared.mjs';

export const id = 'code-comments';
export const title = 'Comment discipline rule (.claude/rules/code-comments.md)';
export const group = 'optional';

export function hint() {
  return 'path-scoped rule: no narration, comment only for divergence or non-obvious domain logic, 200-char cap';
}

export function defaultEnabled() {
  return false;
}

export function plan() {
  return [
    rule(
      id,
      'code-comments',
      'path-scoped comment discipline, loaded only when a source file is in play',
    ),
    {
      kind: 'advise',
      text: 'Comment rule installed at .claude/rules/code-comments.md. It is path-scoped via its `paths:` frontmatter — Claude Code loads it only when a matching source file is in the working set, so it adds nothing to the always-loaded surface (needs a build with path-scoped rules; verified on Claude Code 2.1.220). Trim `paths:` to the languages this repo actually has, and keep the frontmatter — a rule file WITHOUT `paths:` is loaded on every turn.',
      module: id,
    },
  ];
}
