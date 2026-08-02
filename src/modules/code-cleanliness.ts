import type { Action } from '../actions.js';
import type { ModuleGroup } from '../module-def.js';
import { reference, rule, skill } from './copy-actions.js';

export const id = 'code-cleanliness';
export const title =
  'Code cleanliness rule + design-principles reference (.claude/rules/ + .claude/reference/)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'path-scoped rule: intention-revealing names, functions under 20-30 lines, no magic values, no dead code. Principles doc is pull-only';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * Ships the rule and its reference doc as a deliberate two-tier split. A path-scoped rule
 * is resident whenever a source file is in the working set, which while coding is every
 * turn, so the rule holds only what must be applied without a lookup. The judgment-heavy
 * theory sits in `.claude/reference/`, which is never auto-loaded, and the rule links to
 * it so even the pointer stays conditional.
 *
 * Two axes are left out on purpose, because the kit already covers them and restating a
 * rule makes the copies drift: comments belong to `code-comments.md`, and formatting
 * belongs to the repo's own linter, wired by `lint-fix`.
 */
export function plan(): Action[] {
  return [
    rule(
      id,
      'code-cleanliness',
      'path-scoped code-health rule, loaded only when a source file is in play',
    ),
    reference(
      id,
      'design-principles',
      'pull-only SOLID/DRY/KISS/YAGNI reference the rule links to',
    ),
    skill(id, 'tidy', 'audit a working diff against the cleanliness rule'),
    {
      kind: 'advise',
      text: 'Cleanliness rule installed at .claude/rules/code-cleanliness.md, path-scoped via its `paths:` frontmatter so Claude Code loads it only when a matching source file is in the working set. Trim `paths:` to the languages this repo actually has, and keep the frontmatter — a rule file WITHOUT `paths:` is loaded on every turn. Its companion .claude/reference/design-principles.md is deliberately NOT auto-loaded: the rule links to it, so it is read on demand when making an abstraction or structure decision. Leave it out of .claude/rules/, which would make it resident and defeat the split.',
      module: id,
    },
  ];
}
