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
  settingsSignature,
} from './merge-settings.js';
import { extractBody, upsertRegion } from './core/regions.js';

import * as core from './modules/core.js';
import * as lintFix from './modules/lint-fix.js';
import * as backlog from './modules/backlog.js';
import * as changesets from './modules/changesets.js';
import * as sessionContext from './modules/session-context.js';
import * as rename from './modules/rename.js';
import * as reviewers from './modules/reviewers.js';
import * as ledger from './modules/ledger.js';
import * as terseStyle from './modules/terse-style.js';
import * as debugSession from './modules/debug-session.js';
import * as plans from './modules/plans.js';
import * as orchestrate from './modules/orchestrate.js';
import * as verifyChanged from './modules/verify-changed.js';
import * as ready from './modules/ready.js';
import * as sweep from './modules/sweep.js';
import * as personaAuditor from './modules/persona-auditor.js';
import * as readGuard from './modules/read-guard.js';
import * as regen from './modules/regen.js';
import * as statusline from './modules/statusline.js';
import * as codeComments from './modules/code-comments.js';
import * as proseVoice from './modules/prose-voice.js';

import type {
  Action,
  ComputeEffectsOptions,
  CopyAction,
  WriteAction,
  SeedAction,
  Ctx,
  Answers,
  Effect,
  KitManifest,
  ModuleDef,
  PlanResult,
  PruneDelete,
  PruneResult,
  SettingsChange,
  SettingsFragment,
  SettingsPlan,
  Settings,
  AdviseAction,
} from './types.js';

export const MODULES: ModuleDef[] = [
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
  orchestrate,
  verifyChanged,
  ready,
  sweep,
  personaAuditor,
  readGuard,
  regen,
  statusline,
  codeComments,
  proseVoice,
];

export class KitError extends Error {}

/**
 * Files the USER owns, of which the kit manages only a region or a few keys. These
 * are never created wholesale, never pruned, and never overwritten outside their
 * managed span.
 */
export const SHARED_HOST_FILES: ReadonlySet<string> = new Set([
  '.claude/settings.json',
  'CLAUDE.md',
  '.gitignore',
  '.prettierignore',
]);

export function defaultModuleIds(ctx: Ctx): string[] {
  return MODULES.filter((m) => m.defaultEnabled(ctx)).map((m) => m.id);
}

// "--modules=ledger,-rename" → adjust defaults additively/subtractively.
export function resolveModuleIds(ctx: Ctx, modulesFlag?: string): string[] {
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

export function buildPlan(ctx: Ctx, answers: Answers): Action[] {
  const actions: Action[] = [];
  for (const module of MODULES) {
    if (!answers.moduleIds.includes(module.id)) continue;
    actions.push(...module.plan(ctx, answers));
  }
  return actions;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

// Whole-file content for the actions that own a whole file. A `region` action does
// not — its bytes depend on the host file, so it is resolved in computeEffects.
function readAction(action: CopyAction | WriteAction | SeedAction): Buffer {
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
  root: string,
  actions: Action[],
  { manifest = null, force = false }: ComputeEffectsOptions = {},
): PlanResult {
  const effects: Effect[] = [];
  const advisories: AdviseAction[] = [];
  const fragments: SettingsFragment[] = [];
  // dest → the content an earlier action in THIS plan will have written there.
  // Only same-plan ordering matters: apply() executes effects in this order.
  const pendingContent = new Map<string, string>();

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

    // A managed region inside a file the user owns. Everything is judged on the
    // BODY between the markers — the host file's other content is theirs and is
    // spliced through untouched by upsertRegion. The manifest therefore records the
    // body hash, which is what makes "you edited our block" detectable without
    // claiming ownership of the whole file.
    if (action.kind === 'region') {
      // Read the content THIS PLAN will have produced by the time apply() reaches
      // us, not just what is on disk. A fresh repo queues `seed CLAUDE.md` before
      // `region CLAUDE.md`; resolving the region against the pre-write snapshot
      // would emit a bare marker block, and apply()'s later write would silently
      // discard everything the seed had put in the file.
      const pending = pendingContent.get(action.dest);
      const current =
        pending ?? (exists ? readFileSync(destAbs, 'utf8') : null);
      const currentBody =
        current === null ? null : extractBody(current, action.region);
      const hash = sha256(action.body);
      const next = upsertRegion(current, action.body, action.region);
      const content = Buffer.from(next.content, 'utf8');

      if (currentBody !== null && currentBody.trim() === action.body.trim()) {
        effects.push({ action, op: 'skip-identical', content, hash });
        continue;
      }
      const recordedHash = manifest?.files?.[action.dest];
      const locallyModified =
        recordedHash !== undefined &&
        currentBody !== null &&
        sha256(currentBody) !== recordedHash;
      if (locallyModified && !force) {
        effects.push({ action, op: 'skip-modified', content, hash });
        continue;
      }
      pendingContent.set(action.dest, next.content);
      effects.push({
        action,
        op: next.status === 'created' ? 'create' : 'update',
        content,
        hash,
      });
      continue;
    }

    if (action.kind === 'seed') {
      if (!exists) pendingContent.set(action.dest, action.content);
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
  let settingsPlan: SettingsPlan | null = null;
  if (fragments.length) {
    const settingsPath = join(root, '.claude', 'settings.json');
    const existedBefore = existsSync(settingsPath);
    let current: Settings = {};
    if (existedBefore) {
      const text = readFileSync(settingsPath, 'utf8');
      try {
        current = parseSettingsText(text);
      } catch (e) {
        throw new KitError(
          `.claude/settings.json is not valid JSON (${(e as Error).message}). ` +
            'Fix it by hand first — the kit will not rewrite a file it cannot parse.',
        );
      }
    }
    const allChanges: SettingsChange[] = [];
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

  // The kit's settings signature is recorded even on a no-change run (the fragments
  // describe the kit's contribution regardless of what's already merged in).
  const signature = settingsSignature(fragments);

  // Every file the current plan produces — the reference set a prune diffs against.
  // `region` is included so a retired region stops being pruned as an orphan; the
  // prune path itself refuses to delete a shared host file (see computePrune).
  const plannedDests = new Set(
    effects
      .filter((e) =>
        ['copy', 'write', 'seed', 'region'].includes(e.action.kind),
      )
      .map((e) => e.action.dest),
  );

  return { effects, settingsPlan, advisories, signature, plannedDests };
}

// Manifest-diff prune (used by update): a file the previous manifest recorded as
// kit-owned but the current plan no longer produces is retired. Delete only
// kit-owned, hash-UNMODIFIED files (a locally-edited one is kept + WARNed unless
// --force); a file already gone is just dropped from the manifest. Also names the
// retired hook SCRIPTS so the caller can unwire them. Pure computation — only
// apply() writes; dry-run renders exactly this.
// → { deletes:[{dest, modified?, gone?}], kept:[dest], removedScripts:[basename] }
export function computePrune(
  root: string,
  {
    manifest,
    plannedDests,
    force = false,
  }: {
    manifest?: KitManifest | null;
    plannedDests: Set<string>;
    force?: boolean;
  },
): PruneResult {
  const deletes: PruneDelete[] = [];
  const kept: string[] = [];
  for (const [dest, hash] of Object.entries(manifest?.files ?? {})) {
    if (plannedDests.has(dest)) continue; // still produced by a current module
    // Never prune a file the user owns and we only manage a region or a few keys
    // of. A stale manifest entry here would otherwise propose deleting their
    // CLAUDE.md outright — the manifest hash for these is the BODY's, so it would
    // not even register as "locally modified".
    if (SHARED_HOST_FILES.has(dest)) continue;
    const abs = join(root, dest);
    if (!existsSync(abs)) {
      deletes.push({ dest, gone: true });
      continue;
    }
    const modified = sha256(readFileSync(abs)) !== hash;
    if (modified && !force) {
      kept.push(dest);
      continue;
    }
    deletes.push({ dest, modified });
  }

  // Retired scripts (that a hook might still reference) — surfaced for unwiring.
  const removedScripts = deletes
    .filter((d) => /^\.claude\/scripts\/.+\.mjs$/.test(d.dest))
    .map((d) => d.dest.split('/').pop())
    .filter((name): name is string => name !== undefined);

  return { deletes, kept, removedScripts };
}
