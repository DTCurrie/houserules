// output-compactor module (claude-kit CLI, EXPERIMENTAL): PostToolUse(Bash) hook
// that spills oversized command output to a local file and hands the model a
// head+tail+pointer instead (compress-cache-retrieve, in ~60 lines of node).
// Default OFF: it adds ~30-50ms node startup per Bash call, and it depends on
// hook `updatedToolOutput` support — where unsupported it no-ops harmlessly.

import { hookFragment, script } from './shared.mjs';

export const id = 'output-compactor';
export const title = 'Tool-output compactor (experimental)';
export const group = 'experimental';

export function hint() {
  return 'spills >10k-char Bash output to .claude/tool-output/ and injects head+tail+pointer';
}

export function defaultEnabled() {
  return false;
}

export function plan() {
  return [
    script(id, 'compact-tool-output.mjs', 'PostToolUse hook: compact oversized Bash output'),
    {
      kind: 'write',
      dest: '.claude/tool-output/.gitignore',
      content: '*\n',
      module: id,
      reason: 'spill directory ignores itself (repo .gitignore untouched)',
    },
    {
      kind: 'merge-settings',
      module: id,
      fragment: hookFragment('PostToolUse', 'Bash', 'compact-tool-output.mjs'),
    },
    {
      kind: 'advise',
      text: 'Output compactor is EXPERIMENTAL: tune/disable via kit.config.json `compactor`; full outputs land in .claude/tool-output/ (self-gitignored).',
      module: id,
    },
  ];
}
