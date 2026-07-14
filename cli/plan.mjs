// The plan engine (claude-kit CLI).
//
// Modules declare WHAT should exist; they never touch the filesystem. A module is
// { id, title, group, hint(ctx), defaultEnabled(ctx), plan(ctx, answers) } and
// plan() returns actions:
//
//   { kind: 'copy',  src, dest, mode?, module, reason }   kit-owned file from payload/
//   { kind: 'write', dest, content, mode?, module, reason } kit-owned generated file
//   { kind: 'seed',  dest, content, module, reason }      user-owned; only if absent
//   { kind: 'merge-settings', fragment, module }          hooks/permissions fragment
//   { kind: 'advise', text, module }                      next-steps checklist item
//
// computeEffects() turns actions into effects against the real tree — the SAME
// result object drives the dry-run preview and apply.mjs, so the preview cannot lie.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  mergeSettings,
  parseSettingsText,
  renderSettings,
} from './merge-settings.mjs';

import * as core from './modules/core.mjs';
import * as lintFix from './modules/lint-fix.mjs';
import * as backlog from './modules/backlog.mjs';
import * as changesets from './modules/changesets.mjs';
import * as sessionContext from './modules/session-context.mjs';
import * as rename from './modules/rename.mjs';
import * as reviewers from './modules/reviewers.mjs';
import * as ledger from './modules/ledger.mjs';
import * as terseStyle from './modules/terse-style.mjs';
import * as debugSession from './modules/debug-session.mjs';
import * as plans from './modules/plans.mjs';

export const MODULES = [
  core,
  lintFix,
  backlog,
  changesets,
  sessionContext,
  rename,
  reviewers,
  ledger,
  terseStyle,
  debugSession,
  plans,
];

export class KitError extends Error {}

export function defaultModuleIds(ctx) {
  return MODULES.filter((m) => m.defaultEnabled(ctx)).map((m) => m.id);
}

// "--modules=ledger,-rename" → adjust defaults additively/subtractively.
export function resolveModuleIds(ctx, modulesFlag) {
  const ids = new Set(defaultModuleIds(ctx));
  const known = new Set(MODULES.map((m) => m.id));
  for (const raw of (modulesFlag ?? '').split(',')) {
    const token = raw.trim();
    if (!token) continue;
    const remove = token.startsWith('-');
    const id = remove ? token.slice(1) : token;
    if (!known.has(id)) {
      throw new KitError(
        `Unknown module "${id}". Known modules: ${[...known].join(', ')}`,
      );
    }
    if (remove) ids.delete(id);
    else ids.add(id);
  }
  ids.add('core');
  return MODULES.map((m) => m.id).filter((id) => ids.has(id));
}

export function buildPlan(ctx, answers) {
  const actions = [];
  for (const module of MODULES) {
    if (!answers.moduleIds.includes(module.id)) continue;
    actions.push(...module.plan(ctx, answers));
  }
  return actions;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function readAction(action) {
  if (action.kind === 'copy') {
    if (!existsSync(action.src))
      throw new KitError(`Kit payload file missing: ${action.src}`);
    return readFileSync(action.src);
  }
  return Buffer.from(action.content, 'utf8');
}

// → { effects, settingsPlan, advisories }
//   effect: { action, op: create|update|skip-identical|skip-exists|skip-modified, content?, hash? }
export function computeEffects(
  root,
  actions,
  { manifest = null, force = false } = {},
) {
  const effects = [];
  const advisories = [];
  const fragments = [];

  for (const action of actions) {
    if (action.kind === 'advise') {
      advisories.push(action);
      continue;
    }
    if (action.kind === 'merge-settings') {
      fragments.push(action.fragment);
      continue;
    }

    const destAbs = join(root, action.dest);
    const exists = existsSync(destAbs);

    if (action.kind === 'seed') {
      effects.push({
        action,
        op: exists ? 'skip-exists' : 'create',
        content: exists ? null : Buffer.from(action.content, 'utf8'),
      });
      continue;
    }

    // copy | write — kit-owned
    const content = readAction(action);
    const hash = sha256(content);
    if (!exists) {
      effects.push({ action, op: 'create', content, hash });
      continue;
    }
    const onDisk = readFileSync(destAbs);
    if (onDisk.equals(content)) {
      effects.push({ action, op: 'skip-identical', content, hash });
      continue;
    }
    const recordedHash = manifest?.files?.[action.dest];
    const locallyModified =
      recordedHash !== undefined && sha256(onDisk) !== recordedHash;
    if (locallyModified && !force) {
      effects.push({ action, op: 'skip-modified', content, hash });
      continue;
    }
    effects.push({ action, op: 'update', content, hash });
  }

  // All modules' settings fragments merge into one pass over the real file.
  let settingsPlan = null;
  if (fragments.length) {
    const settingsPath = join(root, '.claude', 'settings.json');
    const existedBefore = existsSync(settingsPath);
    let current = {};
    if (existedBefore) {
      const text = readFileSync(settingsPath, 'utf8');
      try {
        current = parseSettingsText(text);
      } catch (e) {
        throw new KitError(
          `.claude/settings.json is not valid JSON (${e.message}). ` +
            'Fix it by hand first — the kit will not rewrite a file it cannot parse.',
        );
      }
    }
    const allChanges = [];
    let merged = current;
    for (const fragment of fragments) {
      const result = mergeSettings(merged, fragment);
      merged = result.merged;
      allChanges.push(...result.changes);
    }
    settingsPlan = {
      dest: '.claude/settings.json',
      existedBefore,
      changes: allChanges,
      text: renderSettings(merged),
    };
  }

  return { effects, settingsPlan, advisories };
}
