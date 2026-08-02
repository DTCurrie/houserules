import type { Action } from '../actions.js';
import type { ModuleGroup } from '../module-def.js';
import { rule } from './copy-actions.js';

export const id = 'testing';
export const title = 'Testing discipline rule (.claude/rules/testing.md)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'path-scoped rule: colocate unit tests in `__test__`, prefer units over end-to-end, behavioral test names, no comments explaining assertions';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * Scoped to test files rather than to sources, unlike `code-cleanliness`. The axis it
 * governs only applies while a test is in the working set, so a `paths:` list of test
 * suffixes keeps it out of the budget on every other turn.
 *
 * No companion reference doc. The rule is short enough to stay resident, and the two-tier
 * split `code-cleanliness` uses only pays off when judgment-heavy theory would otherwise
 * sit loaded. Revisit if this grows past roughly 150 lines.
 */
export function plan(): Action[] {
  return [
    rule(
      id,
      'testing',
      'path-scoped testing rule, loaded only when a test file is in play',
    ),
    {
      kind: 'advise',
      text: 'Testing rule installed at .claude/rules/testing.md, path-scoped via its `paths:` frontmatter so Claude Code loads it only when a test file is in the working set. Trim `paths:` to the suffixes this repo actually uses, and keep the frontmatter — a rule file WITHOUT `paths:` is loaded on every turn. Two of its rules need a decision from you: pick ONE test suffix (.test.ts or .spec.ts) if the repo currently mixes them, and confirm tests are excluded from your build config. A test under a compiled source root is emitted into the published output and imports the test runner, which is a dev dependency.',
      module: id,
    },
  ];
}
