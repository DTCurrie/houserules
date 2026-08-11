import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { claudeMdRegion } from '../core/claude-md-region.js';
import { ledgerDirFor } from '../core/ledger-dir.js';
import { payloadPath } from '../paths.js';
import {
  renderClaudeAdditions,
  renderClaudeMd,
  renderKitConfig,
} from '../render.js';
import type { Action, Answers, ModuleGroup } from '@agent-kit/api';
import type { Ctx } from '../detect.js';
import { lib, script, selfGitignoreAction, template } from './copy-actions.js';
import { hookFragment } from '@agent-kit/api';

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

/** The shared libs and scripts every install needs, regardless of which other modules run. */
function libActions(): Action[] {
  const actions: Action[] = [];
  // Every shared lib the scripts import must be listed here. A script installed
  // without its lib fails at runtime with ERR_MODULE_NOT_FOUND, in the user's repo.
  for (const name of [
    'kit-config.mjs',
    'backlog-id.mjs',
    'entry-ledger.mjs',
    'ledger-index.mjs',
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
  return actions;
}

/**
 * The raw reference templates staged for hand-instantiation, plus the self-gitignore that
 * keeps them out of commits. The one exclusion is the debugger template, which ships with
 * the debug-session module that references it.
 */
function templateActions(): Action[] {
  const actions: Action[] = [];
  const templatesRoot = payloadPath('kit-templates');
  for (const file of walk(templatesRoot)) {
    const rel = relative(templatesRoot, file).replaceAll('\\', '/');
    if (MODULE_OWNED_TEMPLATES.has(rel)) continue;
    actions.push(template(id, rel));
  }
  // Reference scaffolding, not repo content. A directory-local .gitignore keeps it out of
  // commits without touching the repo's own, and stays tracked so the intent travels.
  actions.push(
    selfGitignoreAction(
      id,
      '.claude/kit-templates/.gitignore',
      [
        '# Reference scaffolding staged by agent-kit, refreshed by `npx agent-kit update`.',
        '# The artifacts you build from these (agents, guardrail docs, CLAUDE.md) live',
        '# elsewhere and are yours to commit — these skeletons are not meant to be.',
      ],
      'templates are reference-only; self-gitignored (repo .gitignore untouched)',
    ),
  );
  return actions;
}

/**
 * The two other self-gitignored kit-owned directories: compiled hook scripts, unless the
 * repo opted into committing them, and the ledger push-queue directory.
 */
function selfGitignoredDirActions(ctx: Ctx): Action[] {
  const actions: Action[] = [];
  // Build output, refreshed by `update`, so a fresh install never commits it. Opt out
  // with kit.config.json `scripts.commit: true`.
  if (ctx.claude.kitConfig?.scripts?.commit !== true) {
    actions.push(
      selfGitignoreAction(
        id,
        '.claude/scripts/.gitignore',
        [
          '# Compiled hook scripts, refreshed by `npx agent-kit update`.',
          '# Build output, not source — not meant to be committed.',
        ],
        'scripts are build output; self-gitignored (repo .gitignore untouched)',
      ),
    );
  }

  // GitHub Projects holds the durable record now. The `.jsonl` here is a local push queue
  // that `projects-sync.mjs push` drains, and `.projects.json` is the local sync enable
  // token, so nothing in this directory is committed. Owned by core rather than by either
  // ledger plugin, because both write into this one directory and two modules cannot own the
  // same dest. The repo root is refused upstream: `*` there would hide every document.
  const ledgerDir = ledgerDirFor(ctx);
  if (ledgerDir) {
    actions.push(
      selfGitignoreAction(
        id,
        `${ledgerDir}/.gitignore`,
        [
          '# This whole directory is local. GitHub Projects is the durable record, the .jsonl',
          '# ledgers here are a push queue drained by `projects-sync.mjs push`, and the .md',
          '# files are a rendered view. The .gitignore itself stays tracked so this rule',
          '# travels with a clone.',
        ],
        'the ledger directory is a local push queue. GitHub Projects is the durable record',
      ),
    );
  }
  return actions;
}

/**
 * The `kit.config.json` seed, and the `CLAUDE.md` seed-or-region: a whole-file seed for a
 * repo with no CLAUDE.md yet, otherwise the managed region upserted into the existing one.
 */
function claudeMdActions(ctx: Ctx, answers: Answers): Action[] {
  const actions: Action[] = [];
  actions.push({
    kind: 'seed',
    dest: '.claude/kit.config.json',
    content: renderKitConfig(ctx, answers),
    module: id,
    reason: 'per-repo kit config (targets + toolchain)',
    // Resolved option selections have to survive the run that computed them, or `update`
    // re-resolves to each module's defaults and prunes whatever the real selection installed.
    managedKeys: ['moduleOptions'],
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
      text: 'CLAUDE.md region management is disabled (claudeMd.managed: false). See .claude/kit-templates/ for the kit sections to merge by hand.',
      module: id,
    });
  } else {
    actions.push({
      kind: 'region',
      dest: 'CLAUDE.md',
      body: renderClaudeAdditions(ctx, answers),
      region: claudeMdRegion,
      module: id,
      reason:
        'kit sections, maintained in place (content outside the markers is never touched)',
    });
  }
  return actions;
}

/** The two settings fragments core contributes: the Bash guard, and the ledger injector. */
function settingsActions(): Action[] {
  return [
    {
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
    },
    {
      kind: 'merge-settings',
      module: id,
      fragment: hookFragment('UserPromptSubmit', null, 'ledger-inject.mjs'),
    },
  ];
}

/**
 * The always-installed baseline: shared libs, the Bash guard, kit.config.json,
 * permissions, the CLAUDE.md seed or managed region, and template staging.
 */
export function plan(ctx: Ctx, answers: Answers): Action[] {
  return [
    ...libActions(),
    ...templateActions(),
    ...selfGitignoredDirActions(ctx),
    ...claudeMdActions(ctx, answers),
    ...settingsActions(),
  ];
}
