import type { Action } from '../actions.js';
import type { ModuleGroup } from '../module-def.js';
import { rule } from './copy-actions.js';

export const id = 'prose-voice';
export const title = 'Writing voice rule (.claude/rules/prose-voice.md)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'path-scoped rule: plain sentences, no semicolons, em dashes rewritten away, filler cut';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * The writing-voice rule for prose the agent authors: plain sentences, no semicolons, em
 * dashes rewritten away, filler cut, and exact content byte-preserved.
 *
 * Scoped to markdown AND to the same source extensions as code-comments, because a code
 * comment is prose this rule governs. Source globs are not optional decoration: both
 * `code-comments.md` and `testing.md` defer sentence-level voice to this rule, so a
 * markdown-only `paths:` list leaves those pointers dangling on every source file.
 * Dot-directories are listed explicitly, because `**` does not reliably descend into them.
 *
 * Companion to code-comments, which decides whether a comment should exist at all.
 * Neither rule restates the other.
 */
export function plan(): Action[] {
  return [
    rule(
      id,
      'prose-voice',
      'path-scoped writing voice, loaded when a markdown or source file is in play',
    ),
    {
      kind: 'advise',
      text: 'Writing voice rule installed at .claude/rules/prose-voice.md. It applies to prose the agent authors: changesets, plans, docs, PR bodies, and the sentences inside code comments. The `paths:` list covers markdown plus the same source extensions as code-comments, since those rules defer sentence-level voice to this one. The `paths:` frontmatter is also what keeps it off the always-loaded surface, so keep it. A rule file WITHOUT `paths:` loads on every turn. Dot-directories are listed separately because `**` does not reliably descend into them.',
      module: id,
    },
  ];
}
