// core module (claude-kit CLI): always installed. Shared libs, the Bash guard,
// kit.config.json, permissions, CLAUDE.md seed-or-stage, template staging.

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { payloadPath } from '../paths.mjs';
import {
  renderClaudeAdditions,
  renderClaudeMd,
  renderKitConfig,
} from '../render.mjs';
import { hookFragment, lib, script } from './shared.mjs';

export const id = 'core';
export const title = 'Core (config, Bash guard, permissions, CLAUDE.md seed)';
export const group = 'recommended';
export const locked = true;

export function hint() {
  return 'always installed';
}

export function defaultEnabled() {
  return true;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

export function plan(ctx, answers) {
  const actions = [];

  for (const name of ['kit-config.mjs', 'backlog-id.mjs', 'workspaces.mjs']) {
    actions.push(lib(id, name));
  }
  actions.push(
    script(
      id,
      'guard-bash.mjs',
      'PreToolUse guard: git commit/push/stash, gh pr create',
    ),
  );

  // Stage the raw templates for hand-instantiation, whatever modules are chosen.
  const templatesRoot = payloadPath('kit-templates');
  for (const file of walk(templatesRoot)) {
    const rel = relative(templatesRoot, file).replaceAll('\\', '/');
    actions.push({
      kind: 'copy',
      src: file,
      dest: `.claude/kit-templates/${rel}`,
      module: id,
      reason: 'reference template',
    });
  }

  actions.push({
    kind: 'seed',
    dest: '.claude/kit.config.json',
    content: renderKitConfig(ctx, answers),
    module: id,
    reason: 'per-repo kit config (targets + toolchain)',
  });

  // The additions file is always staged (kit-owned reference, idempotent);
  // CLAUDE.md itself is seeded only when absent and never edited afterwards.
  actions.push({
    kind: 'write',
    dest: '.claude/kit-templates/CLAUDE.additions.md',
    content: renderClaudeAdditions(ctx, answers),
    module: id,
    reason: 'kit sections for hand-merging into CLAUDE.md',
  });
  if (ctx.claude.claudeMdExists) {
    actions.push({
      kind: 'advise',
      text: 'Merge .claude/kit-templates/CLAUDE.additions.md into your CLAUDE.md by hand (kit never edits it).',
      module: id,
    });
  } else {
    actions.push({
      kind: 'seed',
      dest: 'CLAUDE.md',
      content: renderClaudeMd(ctx, answers),
      module: id,
      reason: 'CLAUDE.md seeded from detected repo facts',
    });
    actions.push({
      kind: 'advise',
      text: 'Fill the <!-- TODO --> comments in the seeded CLAUDE.md (one-line project description).',
      module: id,
    });
  }

  actions.push({
    kind: 'merge-settings',
    module: id,
    fragment: {
      permissions: {
        allow: [
          'Bash(git status)',
          'Bash(git status:*)',
          'Bash(git diff:*)',
          'Bash(git log:*)',
          'Bash(git show:*)',
        ],
      },
      ...hookFragment('PreToolUse', 'Bash', 'guard-bash.mjs'),
    },
  });

  return actions;
}
