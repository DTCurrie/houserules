import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { payloadPath } from '../paths.js';
import {
  renderClaudeAdditions,
  renderClaudeMd,
  renderKitConfig,
} from '../render.js';
import type { Action } from '../actions.js';
import type { Ctx } from '../detect.js';
import type { Answers, ModuleGroup } from '../module-def.js';
import { lib, script, template } from './copy-actions.js';
import { hookFragment } from './hook-wiring.js';

// Staged by their owning opt-in module rather than by core's blanket walk, so a repo
// that never enables that module does not carry its pattern.
const MODULE_OWNED_TEMPLATES = new Set(['agents/debugger.agent.md.template']);

export const id = 'core';
export const title = 'Core (config, Bash guard, permissions, CLAUDE.md seed)';
export const group: ModuleGroup = 'recommended';
export const locked = true;

export function hint(): string {
  return 'always installed';
}

export function defaultEnabled(): boolean {
  return true;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * The always-installed baseline: shared libs, the Bash guard, kit.config.json,
 * permissions, the CLAUDE.md seed or managed region, and template staging.
 */
export function plan(ctx: Ctx, answers: Answers): Action[] {
  const actions: Action[] = [];

  // Every shared lib the scripts import must be listed here. A script installed
  // without its lib fails at runtime with ERR_MODULE_NOT_FOUND, in the user's repo.
  for (const name of [
    'kit-config.mjs',
    'backlog-id.mjs',
    'entry-ledger.mjs',
    'workspaces.mjs',
    'proc.mjs',
  ]) {
    actions.push(lib(id, name));
  }
  actions.push(
    script(
      id,
      'guard-bash.mjs',
      'PreToolUse guard: git commit/push/stash, gh pr create',
    ),
  );
  // Inert until a prompt actually references a logged ID. Verified on the stock CLI:
  // UserPromptSubmit exit-0 stdout is added to context, same as SessionStart. Reads any
  // kit ledger, so it belongs to core rather than to any one ledger module.
  actions.push(
    script(
      id,
      'ledger-inject.mjs',
      'UserPromptSubmit: inject a referenced backlog or decision entry from the log',
    ),
  );

  // Stage the raw templates for hand-instantiation, whatever modules are chosen. The one
  // exclusion is the debugger, which ships with the debug-session module that references it.
  const templatesRoot = payloadPath('kit-templates');
  for (const file of walk(templatesRoot)) {
    const rel = relative(templatesRoot, file).replaceAll('\\', '/');
    if (MODULE_OWNED_TEMPLATES.has(rel)) continue;
    actions.push(template(id, rel));
  }

  // Reference scaffolding, not repo content. A directory-local .gitignore keeps it out of
  // commits without touching the repo's own, and stays tracked so the intent travels.
  actions.push({
    kind: 'write',
    dest: '.claude/kit-templates/.gitignore',
    content: [
      '# Reference scaffolding staged by claude-kit, refreshed by `npx claude-kit update`.',
      '# The artifacts you build from these (agents, guardrail docs, CLAUDE.md) live',
      '# elsewhere and are yours to commit — these skeletons are not meant to be.',
      '*',
      '!.gitignore',
      '',
    ].join('\n'),
    module: id,
    reason:
      'templates are reference-only; self-gitignored (repo .gitignore untouched)',
  });

  // Build output, refreshed by `update`, so a fresh install never commits it. Opt out
  // with kit.config.json `scripts.commit: true`.
  if (ctx.claude.kitConfig?.scripts?.commit !== true) {
    actions.push({
      kind: 'write',
      dest: '.claude/scripts/.gitignore',
      content: [
        '# Compiled hook scripts, refreshed by `npx claude-kit update`.',
        '# Build output, not source — not meant to be committed.',
        '*',
        '!.gitignore',
        '',
      ].join('\n'),
      module: id,
      reason:
        'scripts are build output; self-gitignored (repo .gitignore untouched)',
    });
  }

  actions.push({
    kind: 'seed',
    dest: '.claude/kit.config.json',
    content: renderKitConfig(ctx, answers),
    module: id,
    reason: 'per-repo kit config (targets + toolchain)',
  });

  // The seed must land BEFORE the region action below, so a brand-new repo gets the file
  // and then the managed block upserted into it in the same run.
  if (!ctx.claude.claudeMdExists) {
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

  // Emitted unconditionally. computeEffects resolves a region against the content the
  // plan has already queued for that path, not just what is on disk.
  if (ctx.claude.kitConfig?.claudeMd?.managed === false) {
    actions.push({
      kind: 'advise',
      text: 'CLAUDE.md region management is disabled (claudeMd.managed: false) — see .claude/kit-templates/ for the kit sections to merge by hand.',
      module: id,
    });
  } else {
    actions.push({
      kind: 'region',
      dest: 'CLAUDE.md',
      body: renderClaudeAdditions(ctx, answers),
      region: {
        id: 'claude-md',
        start: '<!-- claude-kit:claude-md start -->',
        end: '<!-- claude-kit:claude-md end -->',
        anchor: 'after-h1',
        pad: true,
      },
      module: id,
      reason:
        'kit sections, maintained in place (content outside the markers is never touched)',
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

  actions.push({
    kind: 'merge-settings',
    module: id,
    fragment: hookFragment('UserPromptSubmit', null, 'ledger-inject.mjs'),
  });

  return actions;
}
