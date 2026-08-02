// prose-voice module (claude-kit CLI): OPT-IN writing-voice rule for prose the
// agent authors. Ships .claude/rules/prose-voice.md — plain sentences, no
// semicolons, em dashes rewritten away, filler cut, exact content byte-preserved.
//
// Scoped to markdown rather than source, so it fires on the artifacts the agent
// writes as files: changesets, plans, backlog entries, docs, PR bodies staged as
// markdown. Dot-directories are listed explicitly in the rule's `paths:` because
// `**` does not reliably descend into them.
//
// Companion to code-comments: that rule decides WHETHER a comment should exist,
// this one decides how the sentences read. Neither restates the other.

import type { Action, ModuleGroup } from '../types.js';
import { rule } from './shared.js';

export const id = 'prose-voice';
export const title = 'Writing voice rule (.claude/rules/prose-voice.md)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'path-scoped rule: plain sentences, no semicolons, em dashes rewritten away, filler cut';
}

export function defaultEnabled(): boolean {
  return false;
}

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
