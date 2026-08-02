import type { Action, ModuleGroup } from '../types.js';
import { rule } from './shared.js';

export const id = 'code-comments';
export const title = 'Comment discipline rule (.claude/rules/code-comments.md)';
export const group: ModuleGroup = 'optional';

export function hint(): string {
  return 'path-scoped rule: TSDoc for exported API, no file headers or landmarks, no narration, 200-char cap';
}

export function defaultEnabled(): boolean {
  return false;
}

/**
 * Ships the comment-discipline rule: default to no comment, TSDoc for exported API,
 * `//` for everything else, and never a file header or a landmark divider.
 *
 * Delivered as a native path-scoped rule, verified against Claude Code 2.1.220. The body
 * loads only when a matching source file is in the working set, so it costs nothing on
 * the always-loaded surface and needs no CLAUDE.md pointer to maintain. Script-free and
 * hook-free, because the platform does the conditional loading.
 */
export function plan(): Action[] {
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
