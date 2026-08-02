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
 * Scoped to markdown rather than source, so it fires on the artifacts the agent writes as
 * files. Dot-directories are listed explicitly in the rule's `paths:`, because `**` does
 * not reliably descend into them.
 *
 * Companion to code-comments, which decides whether a comment should exist at all.
 * Neither rule restates the other.
 */
export function plan(): Action[] {
  return [
    rule(
      id,
      'prose-voice',
      'path-scoped writing voice, loaded only when a markdown file is in play',
    ),
    {
      kind: 'advise',
      text: 'Writing voice rule installed at .claude/rules/prose-voice.md. It applies to prose the agent authors: changesets, plans, docs, PR bodies. The `paths:` frontmatter is what keeps it off the always-loaded surface, so keep it. A rule file WITHOUT `paths:` loads on every turn. Dot-directories are listed separately because `**` does not reliably descend into them.',
      module: id,
    },
  ];
}
