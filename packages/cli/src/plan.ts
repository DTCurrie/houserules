import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';

import {
  mergeSettings,
  parseSettingsText,
  renderSettings,
  settingsSignature,
} from './merge-settings.js';
import { mergeManagedKeys } from './merge-config-keys.js';
import { extractBody, hasLegacyRegion, upsertRegion } from './core/regions.js';
import { classifyFrontmatter, splitFrontmatter } from './core/frontmatter.js';
import { bodyHashes, wholeFileHash } from './core/manifest.js';

import * as core from './modules/core.js';
import * as lintFix from './modules/lint-fix.js';
import * as sessionContext from './modules/session-context.js';
import * as rename from './modules/rename.js';
import * as reviewers from './modules/reviewers.js';
import * as debugSession from './modules/debug-session.js';
import * as plans from './modules/plans.js';
import * as orchestrate from './modules/orchestrate.js';
import * as verifyChanged from './modules/verify-changed.js';
import * as ready from './modules/ready.js';
import * as sweep from './modules/sweep.js';
import * as readGuard from './modules/read-guard.js';
import * as regen from './modules/regen.js';
import * as statusline from './modules/statusline.js';
import * as codeCleanliness from './modules/code-cleanliness.js';
import * as ciSettings from './modules/ci-settings.js';

import { prettierGuardActions } from './modules/prettier-guard.js';

import type {
  Action,
  AdviseAction,
  BodyAction,
  CopyAction,
  FileAction,
  SeedAction,
  WriteAction,
} from './actions.js';
import type { KitManifest } from './core/manifest.js';
import type { Ctx } from './detect.js';
import type { Answers, ModuleDef } from './module-def.js';
import type { PluginSource, Registry } from './plugin-registry.js';
import type {
  Settings,
  SettingsChange,
  SettingsFragment,
  SettingsPlan,
  SettingsSignature,
} from './merge-settings.js';

/**
 * What computeEffects() concluded an action means against the real tree.
 *
 * - `create`          the file is absent
 * - `update`          kit-owned, differs, and is safe to refresh
 * - `skip-identical`  already byte-identical
 * - `skip-exists`     a seed whose destination exists (user owns it)
 * - `skip-modified`   kit-owned but locally edited. Kept unless --force
 * - `delete`          only produced by the prune path, in apply()
 *
 * For a `region` action these describe the managed BODY, not the host file: a
 * `skip-identical` region means the block already matches, whatever the user has
 * written around it. A `body` action reads the same way, where the managed part is
 * everything below the closing `---` and the frontmatter above it is the user's.
 */
export type EffectOp =
  | 'create'
  | 'update'
  | 'merge'
  | 'skip-identical'
  | 'skip-exists'
  | 'skip-modified'
  | 'delete';

export interface Effect {
  action: FileAction;
  op: EffectOp;
  /** Bytes to write. Null for a skipped seed. */
  content: Buffer | null;
  /**
   * sha256 of `content`, recorded in the manifest for kit-owned files. For a `region` or
   * `body` action it is the hash of the managed part alone, not of the file written.
   */
  hash?: string;
  /**
   * `body` actions only: sha256 of the frontmatter the KIT ships, which is the default a
   * later run compares the user's against. Never the hash of what is on disk. Recorded
   * beside `hash` as {@link BodyHashes}.
   */
  frontmatterHash?: string;
}

export interface ComputeEffectsOptions {
  manifest?: KitManifest | null;
  force?: boolean;
  /**
   * Plugin sources, used to attribute a missing `payload-dist/` file to the plugin that
   * owns it instead of aborting the whole plan. A caller that omits this still gets the
   * old behavior: a missing payload file throws {@link KitError} unconditionally, since
   * there is no way to tell a plugin's file from the kit's own.
   */
  plugins?: PluginSource[];
}

/**
 * One plugin whose `payload-dist/` is missing one or more files a current action needs.
 * Recorded instead of thrown, so a broken plugin does not block the plan of every other
 * one.
 */
export interface BrokenPluginProblem {
  /** The plugin's name, as configured in kit.config.json. */
  plugin: string;
  /** Human-readable, names the plugin, the missing file(s), and the fix. */
  message: string;
}

export interface PlanResult {
  effects: Effect[];
  settingsPlan: SettingsPlan | null;
  advisories: AdviseAction[];
  signature: SettingsSignature;
  /** Every dest the current plan produces. The reference set prune diffs against. */
  plannedDests: Set<string>;
  /** Non-empty when a plugin's built payload is missing a file the plan needs. */
  brokenPlugins: BrokenPluginProblem[];
}

export interface PruneDelete {
  dest: string;
  /** The file was locally edited and --force removed it anyway. */
  modified?: boolean;
  /** Already absent on disk. Just dropped from the manifest. */
  gone?: boolean;
}

export interface PruneResult {
  deletes: PruneDelete[];
  /** Retired but locally edited, so kept. */
  kept: string[];
  /** Basenames of retired hook scripts, so the caller can unwire them. */
  removedScripts: string[];
}

export const MODULES: ModuleDef[] = [
  core,
  lintFix,
  sessionContext,
  rename,
  reviewers,
  debugSession,
  plans,
  orchestrate,
  verifyChanged,
  ready,
  sweep,
  readGuard,
  regen,
  statusline,
  codeCleanliness,
  ciSettings,
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

export function defaultModuleIds(ctx: Ctx, registry: Registry): string[] {
  return registry.modules
    .filter((m) => m.def.defaultEnabled(ctx))
    .map((m) => m.id);
}

/**
 * Adjusts the default module set additively and subtractively. A `--modules` value of
 * `ledger,-rename` adds ledger and withdraws rename. `core` is always re-added.
 *
 * @throws KitError when the flag names a module that does not exist.
 */
export function resolveModuleIds(
  ctx: Ctx,
  registry: Registry,
  modulesFlag?: string,
): string[] {
  const ids = new Set(defaultModuleIds(ctx, registry));
  const known = new Set(registry.modules.map((m) => m.id));
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
  return registry.modules.map((m) => m.id).filter((id) => ids.has(id));
}

export function buildPlan(
  ctx: Ctx,
  answers: Answers,
  registry: Registry,
): Action[] {
  const actions: Action[] = [];
  for (const module of registry.modules) {
    if (!answers.moduleIds.includes(module.id)) continue;
    actions.push(...module.def.plan(ctx, answers));
  }
  // Last, and deliberately outside the loop. The prettier guard derives its block from the
  // dests the plan actually writes, so it has to see every module's actions. Inside core's
  // plan() it saw only core's, which is how `.claude/output-styles/` went unprotected.
  actions.push(...prettierGuardActions(ctx, actions));
  return actions;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

// A `region` action is absent here: its bytes depend on the host file, so it is
// resolved inside computeEffects instead.
//
// A copy action's src is checked by the caller (checkPayloadMissing) before this runs, so
// existence is already guaranteed here.
function readAction(action: CopyAction | WriteAction | SeedAction): Buffer {
  if (action.kind === 'copy') return readFileSync(action.src);
  return Buffer.from(action.content, 'utf8');
}

/** Whether `src` resolves inside one of `plugins`' own package directories. */
function findOwningPlugin(
  src: string,
  plugins: PluginSource[] | undefined,
): PluginSource | undefined {
  return plugins?.find((p) => src === p.dir || src.startsWith(p.dir + sep));
}

function formatBrokenPluginMessage(
  pluginName: string,
  missing: string[],
): string {
  const files = missing.map((src) => `  - ${src}`).join('\n');
  return (
    `plugin "${pluginName}" is missing its built payload. Run this plugin's payload ` +
    `build (its package's \`build\` or \`build:payload\` script) to produce:\n${files}`
  );
}

/**
 * Checks a `copy` or `body` action's payload file. A built-in's missing file is a broken
 * kit install and aborts immediately, since there is no owner to attribute it to and
 * nothing else can produce it. A plugin's missing file is recorded against that plugin in
 * `broken` and `brokenDests` instead, so the caller can skip this one action and keep
 * planning everything else.
 *
 * @returns true when the action's effect should be skipped because its payload is missing.
 */
function checkPayloadMissing(
  action: CopyAction | BodyAction,
  plugins: PluginSource[] | undefined,
  broken: Map<string, string[]>,
  brokenDests: Set<string>,
): boolean {
  if (existsSync(action.src)) return false;
  const plugin = findOwningPlugin(action.src, plugins);
  if (!plugin) throw new KitError(`Kit payload file missing: ${action.src}`);
  const missing = broken.get(plugin.name) ?? [];
  missing.push(action.src);
  broken.set(plugin.name, missing);
  brokenDests.add(action.dest);
  return true;
}

/**
 * Decides what `computeEffects` does with ONE kit-owned file. Pure: the caller resolves
 * the bytes and the recorded hash, this only judges them.
 *
 * This encodes the kit-owned versus user-owned rule, which is the invariant the whole
 * update story rests on. A file whose current bytes differ from the hash the manifest
 * recorded is one YOU edited, and it is never refreshed without `force`. A file matching
 * its recorded hash is one only the KIT has written, so a content change means the kit
 * moved on and the refresh is safe and silent.
 *
 * @param recordedHash From the manifest. `undefined` means the kit never wrote this path,
 *   so there is nothing to have diverged from and the file is refreshable.
 */
export function classifyWrite(args: {
  exists: boolean;
  onDisk: Buffer | null;
  canonical: Buffer;
  recordedHash: string | undefined;
  force: boolean;
}): 'create' | 'skip-identical' | 'skip-modified' | 'update' {
  const { exists, onDisk, canonical, recordedHash, force } = args;
  if (!exists || onDisk === null) return 'create';
  if (onDisk.equals(canonical)) return 'skip-identical';
  const locallyModified =
    recordedHash !== undefined && sha256(onDisk) !== recordedHash;
  if (locallyModified && !force) return 'skip-modified';
  return 'update';
}

/**
 * Turns the actions modules declared into effects against the real tree. The same
 * result object drives the dry-run preview and `apply()`, so the preview cannot lie.
 *
 * @param force Refresh kit-owned files even when the manifest hash says you edited them.
 */
export function computeEffects(
  root: string,
  actions: Action[],
  { manifest = null, force = false, plugins }: ComputeEffectsOptions = {},
): PlanResult {
  const effects: Effect[] = [];
  const advisories: AdviseAction[] = [];
  const fragments: SettingsFragment[] = [];
  // dest → the content an earlier action in THIS plan will have written there.
  // Only same-plan ordering matters: apply() executes effects in this order.
  const pendingContent = new Map<string, string>();
  // Plugin name → its missing payload src paths, and the dests those actions would have
  // produced. The dests are folded into plannedDests below so a broken plugin's
  // already-installed files are not mistaken for retired ones and pruned.
  const broken = new Map<string, string[]>();
  const brokenDests = new Set<string>();
  // dest → src of the copy already planned there. Core hand-lists every shared lib
  // unconditionally (modules/core.ts), and a plugin's sidecar independently derives a copy
  // of the same lib from the same CLI payload, so the two actions are byte-identical: same
  // dest, same src, different `module`. Deduping only when both match is what keeps this
  // safe for a genuine dest collision between two DIFFERENT sources, which stays a bug this
  // does not paper over.
  const seenCopySrc = new Map<string, string>();

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

    if (action.kind === 'region') {
      // What THIS PLAN will have written by the time apply() gets here, not just what is
      // on disk. A fresh repo queues `seed CLAUDE.md` before `region CLAUDE.md`.
      const pending = pendingContent.get(action.dest);
      const current =
        pending ?? (exists ? readFileSync(destAbs, 'utf8') : null);
      const currentBody =
        current === null ? null : extractBody(current, action.region);
      // Trimmed on both sides, and on the recorded hash too. A padded region writes
      // `start\n\nbody\n\nend`, and extractBody strips only one newline from each end, so a
      // region read back from disk is never byte-identical to the body that produced it.
      // Comparing untrimmed made `locallyModified` true for every padded region whose body
      // legitimately changed, which meant a kit upgrade reported CLAUDE.md as user-edited and
      // refused to touch it. Only the skip-identical check above, which already trimmed, hid it.
      const hash = sha256(action.body.trim());
      const next = upsertRegion(current, action.body, action.region);
      const content = Buffer.from(next.content, 'utf8');

      if (currentBody !== null && currentBody.trim() === action.body.trim()) {
        effects.push({ action, op: 'skip-identical', content, hash });
        continue;
      }
      const recordedHash = wholeFileHash(manifest, action.dest);
      // A block still under the legacy markers was recorded by an older kit generation whose
      // hash semantics are not this one's, so the comparison below would report drift for every
      // such install and strand it on the old markers behind a --force it has no reason to run.
      const adoptingLegacy =
        current !== null && hasLegacyRegion(current, action.region);
      const locallyModified =
        !adoptingLegacy &&
        recordedHash !== undefined &&
        currentBody !== null &&
        sha256(currentBody.trim()) !== recordedHash;
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

    if (action.kind === 'body') {
      if (checkPayloadMissing(action, plugins, broken, brokenDests)) continue;
      const shipped = readFileSync(action.src, 'utf8');
      const { frontmatter: shippedFrontmatter, body: payloadBody } =
        splitFrontmatter(shipped);
      // The kit-owned body is the payload's plus whatever the module computed from the
      // user's selections, so the hash covers both and a changed selection refreshes it.
      const canonicalBody = payloadBody + (action.appendBody ?? '');
      const hash = sha256(canonicalBody);
      const frontmatterHash = sha256(shippedFrontmatter);

      if (!exists) {
        effects.push({
          action,
          op: 'create',
          content: Buffer.from(shippedFrontmatter + canonicalBody, 'utf8'),
          hash,
          frontmatterHash,
        });
        continue;
      }

      const diskText = readFileSync(destAbs, 'utf8');
      const { frontmatter: diskFrontmatter, body: diskBody } =
        splitFrontmatter(diskText);
      const frontmatterState = classifyFrontmatter({
        onDisk: sha256(diskFrontmatter),
        recordedDefault: bodyHashes(manifest, action.dest)?.frontmatter,
        shippedDefault: frontmatterHash,
      });
      const resolvedFrontmatter =
        frontmatterState === 'default' ? shippedFrontmatter : diskFrontmatter;
      const content = Buffer.from(resolvedFrontmatter + canonicalBody, 'utf8');

      if (resolvedFrontmatter + canonicalBody === diskText) {
        effects.push({
          action,
          op: 'skip-identical',
          content,
          hash,
          frontmatterHash,
        });
        continue;
      }

      const recordedBody = bodyHashes(manifest, action.dest);
      const recordedWholeFile = wholeFileHash(manifest, action.dest);
      let locallyModified: boolean;
      if (recordedBody !== undefined) {
        locallyModified = sha256(diskBody) !== recordedBody.body;
      } else if (recordedWholeFile !== undefined) {
        // A legacy manifest entry, written before body ownership existed, holds the
        // hash of the WHOLE file. An untouched install still matches that hash and
        // must adopt cleanly rather than read as modified on its first body-owned update.
        locallyModified = sha256(diskText) !== recordedWholeFile;
      } else {
        locallyModified = false;
      }

      if (locallyModified && !force) {
        effects.push({
          action,
          op: 'skip-modified',
          content,
          hash,
          frontmatterHash,
        });
        continue;
      }
      effects.push({ action, op: 'update', content, hash, frontmatterHash });
      continue;
    }

    if (action.kind === 'seed') {
      if (!exists) pendingContent.set(action.dest, action.content);
      // A seed with managedKeys reconciles those keys into a file that already exists. Every
      // other byte, including the user's edits to the managed keys' neighbours, is preserved.
      const mergedText =
        exists && action.managedKeys?.length
          ? mergeManagedKeys(
              readFileSync(destAbs, 'utf8'),
              action.content,
              action.managedKeys,
            )
          : null;
      if (mergedText !== null) {
        effects.push({
          action,
          op: 'merge',
          content: Buffer.from(mergedText, 'utf8'),
        });
        continue;
      }
      effects.push({
        action,
        op: exists ? 'skip-exists' : 'create',
        content: exists ? null : Buffer.from(action.content, 'utf8'),
      });
      continue;
    }

    // copy | write: kit-owned
    if (action.kind === 'copy') {
      if (seenCopySrc.get(action.dest) === action.src) continue;
      seenCopySrc.set(action.dest, action.src);
      if (checkPayloadMissing(action, plugins, broken, brokenDests)) continue;
    }
    const content = readAction(action);
    const hash = sha256(content);
    const op = classifyWrite({
      exists,
      onDisk: exists ? readFileSync(destAbs) : null,
      canonical: content,
      recordedHash: wholeFileHash(manifest, action.dest),
      force,
    });
    effects.push({ action, op, content, hash });
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

  // `region` and `body` are included so a retired one stops being pruned as an orphan.
  // brokenDests too: a broken plugin's already-installed file did not get an effect this
  // run, but it is still meant to exist, so it must not read as retired and get pruned.
  const plannedDests = new Set([
    ...effects
      .filter((e) =>
        ['copy', 'write', 'seed', 'region', 'body'].includes(e.action.kind),
      )
      .map((e) => e.action.dest),
    ...brokenDests,
  ]);

  const brokenPlugins: BrokenPluginProblem[] = [...broken.entries()].map(
    ([plugin, missing]) => ({
      plugin,
      message: formatBrokenPluginMessage(plugin, missing),
    }),
  );

  return {
    effects,
    settingsPlan,
    advisories,
    signature,
    plannedDests,
    brokenPlugins,
  };
}

/**
 * Manifest-diff prune, used by `update`. A file the previous manifest recorded as
 * kit-owned but the current plan no longer produces is retired. Only kit-owned,
 * hash-unmodified files are deleted. A locally edited one is kept and warned about
 * unless `force`. A file already gone is just dropped from the manifest.
 *
 * Pure computation. Only `apply()` writes, and dry-run renders exactly this.
 *
 * @returns The deletions, the retired-but-kept files, and the basenames of retired hook
 * scripts so the caller can unwire them.
 */
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
    // A stale manifest entry here would propose deleting the user's CLAUDE.md outright.
    // The recorded hash is the region BODY's, so it would not even read as modified.
    if (SHARED_HOST_FILES.has(dest)) continue;
    const abs = join(root, dest);
    if (!existsSync(abs)) {
      deletes.push({ dest, gone: true });
      continue;
    }
    const modified =
      typeof hash === 'object'
        ? sha256(splitFrontmatter(readFileSync(abs, 'utf8')).body) !== hash.body
        : sha256(readFileSync(abs)) !== hash;
    if (modified && !force) {
      kept.push(dest);
      continue;
    }
    deletes.push({ dest, modified });
  }

  // Retired scripts (that a hook might still reference). Surfaced for unwiring.
  const removedScripts = deletes
    .filter((d) => /^\.claude\/scripts\/.+\.mjs$/.test(d.dest))
    .map((d) => d.dest.split('/').pop())
    .filter((name): name is string => name !== undefined);

  return { deletes, kept, removedScripts };
}
