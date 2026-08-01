// core module (claude-kit CLI): always installed. Shared libs, the Bash guard,
// kit.config.json, permissions, CLAUDE.md seed-or-stage, template staging.

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import { payloadPath } from '../paths.js';
import {
  renderClaudeAdditions,
  renderClaudeMd,
  renderKitConfig,
} from '../render.js';
import type { Action, Answers, Ctx, ModuleGroup } from '../types.js';
import { hookFragment, lib, script, template } from './shared.js';

// Templates staged by an opt-in module (not by core's blanket walk), so a repo that
// never enables the owning module doesn't carry its pattern. See ledger.mjs /
// debug-session.mjs, which stage these via template().
const MODULE_OWNED_TEMPLATES = new Set([
  'agents/archivist.agent.md.template',
  'agents/debugger.agent.md.template',
  'agents/persona-auditor.agent.md.template',
]);

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

export function plan(ctx: Ctx, answers: Answers): Action[] {
  const actions: Action[] = [];

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

  // Stage the raw templates for hand-instantiation, whatever modules are chosen
  // (except the archivist, which ships with the ledger module that references it).
  const templatesRoot = payloadPath('kit-templates');
  for (const file of walk(templatesRoot)) {
    const rel = relative(templatesRoot, file).replaceAll('\\', '/');
    if (MODULE_OWNED_TEMPLATES.has(rel)) continue;
    actions.push(template(id, rel));
  }

  // The staged templates (and the CLAUDE.additions merge helper) are reference
  // scaffolding, not repo content: a directory-local .gitignore keeps them out of
  // commits while leaving them on disk for reference. The repo's own .gitignore is
  // never touched; the .gitignore itself stays tracked so the intent travels with the repo.
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

  actions.push({
    kind: 'seed',
    dest: '.claude/kit.config.json',
    content: renderKitConfig(ctx, answers),
    module: id,
    reason: 'per-repo kit config (targets + toolchain)',
  });

  // CLAUDE.md itself is seeded only when absent; the seed must land BEFORE the
  // region action below so a brand-new repo gets the seeded file and then the
  // managed block is upserted into it in the same run.
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

  // Managed region: the kit maintains its sections in place inside the user's
  // CLAUDE.md, writing only between the markers. Opt out via kit.config.json
  // (claudeMd.managed: false) to fall back to hand-merge staging instead.
  //
  // Emitted unconditionally, including on a fresh repo where the seed above creates
  // the file in this same plan: computeEffects resolves a region against the content
  // the plan has already queued for that path, not just what is on disk.
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

  return actions;
}
