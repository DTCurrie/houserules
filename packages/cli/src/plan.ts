import { planPrepareScript, type PrepareScriptPlan } from './prepare-script.js';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';

import {
  mergeSettings,
  parseSettingsText,
  renderSettings,
  settingsSignature,
  extractBody,
  hasLegacyRegion,
  upsertRegion,
  bodyHashes,
  wholeFileHash,
} from '@houserules/api/internal';
import { HouseError } from './house-error.js';
import { mergeManagedKeys } from './merge-config-keys.js';
import { classifyFrontmatter, splitFrontmatter } from './core/frontmatter.js';

import * as core from './modules/core.js';
import * as lintFix from './modules/lint-fix.js';
import * as sessionContext from './modules/session-context.js';
import * as rename from './modules/rename.js';
import * as reviewers from './modules/reviewers.js';
import * as debugSession from './modules/debug-session.js';
import * as plans from './modules/plans.js';
import * as orchestrate from './modules/orchestrate.js';
import * as research from './modules/research.js';
import * as verifyChanged from './modules/verify-changed.js';
import * as ready from './modules/ready.js';
import * as sweep from './modules/sweep.js';
import * as readGuard from './modules/read-guard.js';
import * as regen from './modules/regen.js';
import * as statusline from './modules/statusline.js';
import * as toolOutputTrim from './modules/tool-output-trim.js';
import * as codeCleanliness from './modules/code-cleanliness.js';
import * as ciSettings from './modules/ci-settings.js';

import { prettierGuardActions } from './modules/prettier-guard.js';
import { payloadGitignoreActions } from './modules/payload-gitignore.js';

import type {
  Action,
  AdviseAction,
  BodyAction,
  CopyAction,
  FileAction,
  RegionAction,
  SeedAction,
  WriteAction,
  Answers,
  ModuleDef,
  Settings,
  SettingsFragment,
} from '@houserules/api';
import type {
  HouseManifest,
  SettingsChange,
  SettingsPlan,
  SettingsSignature,
} from '@houserules/api/internal';
import type { Ctx } from './detect.js';
import type { PluginSource, Registry } from './plugin-registry.js';

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
   * `body` actions only: sha256 of the frontmatter houserules ships, which is the default a
   * later run compares the user's against. Never the hash of what is on disk. Recorded
   * beside `hash` as {@link BodyHashes}.
   */
  frontmatterHash?: string;
  /**
   * `region` actions with op `update` only: the managed block's body as it stood before this
   * plan, so a preview can show what changes. Absent on every other effect.
   */
  previousBody?: string;
}

export interface ComputeEffectsOptions {
  manifest?: HouseManifest | null;
  force?: boolean;
  /**
   * Plugin sources, used to attribute a missing `payload-dist/` file to the plugin that
   * owns it instead of aborting the whole plan. A caller that omits this still gets the
   * old behavior: a missing payload file throws {@link HouseError} unconditionally, since
   * there is no way to tell a plugin's file from houserules' own.
   */
  plugins?: PluginSource[];
  /** Plan the `prepare` script edit. `init` and a non-sync `update` set it. */
  shouldPlanPrepare?: boolean;
}

/**
 * One plugin whose `payload-dist/` is missing one or more files a current action needs.
 * Recorded instead of thrown, so a broken plugin does not block the plan of every other
 * one.
 */
interface BrokenPluginProblem {
  /** The plugin's name, as configured in houserules.config.json. */
  plugin: string;
  /** Human-readable, names the plugin, the missing file(s), and the fix. */
  message: string;
}

export interface PlanResult {
  effects: Effect[];
  settingsPlan: SettingsPlan | null;
  /**
   * The root `package.json` `prepare` edit. Present only when the caller asked for it with
   * {@link ComputeEffectsOptions.shouldPlanPrepare}, so `modules` and `doctor` never carry it.
   */
  prepareScript?: PrepareScriptPlan;
  advisories: AdviseAction[];
  signature: SettingsSignature;
  /**
   * Every module's settings fragment this run resolved, exposed so a caller can reconcile
   * a previously recorded {@link SettingsSignature} against what is CURRENTLY declared,
   * such as `update`'s stale-hook cleanup.
   */
  fragments: SettingsFragment[];
  /** Every dest the current plan produces. The reference set prune diffs against. */
  plannedDests: Set<string>;
  /** Non-empty when a plugin's built payload is missing a file the plan needs. */
  brokenPlugins: BrokenPluginProblem[];
}

interface PruneDelete {
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
  research,
  verifyChanged,
  ready,
  sweep,
  readGuard,
  regen,
  statusline,
  toolOutputTrim,
  codeCleanliness,
  ciSettings,
];

/**
 * Files the USER owns, of which houserules manages only a region or a few keys. These
 * are never created wholesale, never pruned, and never overwritten outside their
 * managed span.
 */
export const SHARED_HOST_FILES: ReadonlySet<string> = new Set([
  '.claude/settings.json',
  'CLAUDE.md',
  'AGENTS.md',
  '.gitignore',
  '.prettierignore',
  '.claude/.gitignore',
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
 * @throws HouseError when the flag names a module that does not exist.
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
      throw new HouseError(
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
  const selected = registry.modules.filter((module) =>
    answers.moduleIds.includes(module.id),
  );
  // Collected before any plan() runs, because core renders them and core plans first.
  const planAnswers: Answers = {
    ...answers,
    contributedSkillTriggers: selected.flatMap(
      (module) => module.def.skillTriggers?.(answers) ?? [],
    ),
  };
  const actions: Action[] = [];
  for (const module of selected) {
    actions.push(...module.def.plan(ctx, planAnswers));
  }
  // Last, and deliberately outside the loop. The prettier guard derives its block from the
  // dests the plan actually writes, so it has to see every module's actions. Inside core's
  // plan() it saw only core's, which is how `.claude/output-styles/` went unprotected.
  // Both derive from the module actions alone, so neither block lists the other's region.
  const derived = [
    ...prettierGuardActions(ctx, actions),
    ...payloadGitignoreActions(ctx, actions),
  ];
  actions.push(...derived);
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
  if (action.kind === 'copy') {
    const payload = readFileSync(action.src);
    return action.appendBody
      ? Buffer.concat([payload, Buffer.from(action.appendBody, 'utf8')])
      : payload;
  }
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
 * houserules install and aborts immediately, since there is no owner to attribute it to and
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
  if (!plugin) throw new HouseError(`Kit payload file missing: ${action.src}`);
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
 * its recorded hash is one only houserules has written, so a content change means houserules
 * moved on and the refresh is safe and silent.
 *
 * The one exception is a `generated` file, build output under a self-gitignored directory.
 * Git never carries it, so a checkout that pulls a newer manifest holds an older copy whose
 * mismatch is not an edit, and it refreshes like any file houserules alone has written.
 *
 * @param recordedHash From the manifest. `undefined` means houserules never wrote this path,
 *   so there is nothing to have diverged from and the file is refreshable.
 * @param isGenerated The dest sits under a self-gitignored generated directory this plan
 *   writes the `.gitignore` for. See {@link SELF_GITIGNORED_GENERATED_DIRS}.
 */
export function classifyWrite(args: {
  exists: boolean;
  onDisk: Buffer | null;
  canonical: Buffer;
  recordedHash: string | undefined;
  force: boolean;
  isGenerated?: boolean;
}): 'create' | 'skip-identical' | 'skip-modified' | 'update' {
  const { exists, onDisk, canonical, recordedHash, force, isGenerated } = args;
  if (!exists || onDisk === null) return 'create';
  if (onDisk.equals(canonical)) return 'skip-identical';
  const locallyModified =
    recordedHash !== undefined && sha256(onDisk) !== recordedHash;
  if (locallyModified && !force && !isGenerated) return 'skip-modified';
  return 'update';
}

/**
 * The kit-owned directories whose contents are build output, self-gitignored by the
 * `.gitignore` writes in `modules/core.ts`. That list is built inline there, not exported,
 * so this names the two again. A directory counts only when the plan also writes its
 * `.gitignore`, so `scripts.commit: true`, which drops the scripts one, keeps committed
 * scripts under the edit rule. The ledger directory self-gitignores too but holds local
 * records, not generated copies, so it is left out.
 */
const SELF_GITIGNORED_GENERATED_DIRS = [
  '.claude/scripts',
  '.claude/templates',
] as const;

/** The generated directories this plan self-gitignores, from its own `.gitignore` writes. */
function generatedDirsIn(actions: Action[]): string[] {
  return SELF_GITIGNORED_GENERATED_DIRS.filter((dir) =>
    actions.some(
      (action) =>
        action.kind === 'write' && action.dest === `${dir}/.gitignore`,
    ),
  );
}

/**
 * Whether a dest is build output git never carries. The `.gitignore` itself is excluded:
 * its `!.gitignore` line keeps it tracked, so a mismatch there is a real edit.
 */
function isGeneratedDest(dest: string, generatedDirs: string[]): boolean {
  return generatedDirs.some(
    (dir) => dest.startsWith(`${dir}/`) && dest !== `${dir}/.gitignore`,
  );
}

/**
 * A managed marker-delimited block inside a file the user otherwise owns. Bytes outside
 * the markers are read but never touched.
 */
function effectForRegion(
  action: RegionAction,
  destAbs: string,
  exists: boolean,
  manifest: HouseManifest | null,
  force: boolean,
  pendingContent: Map<string, string>,
): Effect {
  // What THIS PLAN will have written by the time apply() gets here, not just what is
  // on disk. A fresh repo queues `seed CLAUDE.md` before `region CLAUDE.md`.
  const pending = pendingContent.get(action.dest);
  const current = pending ?? (exists ? readFileSync(destAbs, 'utf8') : null);
  const currentBody =
    current === null ? null : extractBody(current, action.region);
  // Trimmed on both sides, and on the recorded hash too. A padded region writes
  // `start\n\nbody\n\nend`, and extractBody strips only one newline from each end, so a
  // region read back from disk is never byte-identical to the body that produced it.
  // Comparing untrimmed made `locallyModified` true for every padded region whose body
  // legitimately changed, which meant a houserules upgrade reported CLAUDE.md as user-edited and
  // refused to touch it. Only the skip-identical check above, which already trimmed, hid it.
  const hash = sha256(action.body.trim());
  const next = upsertRegion(current, action.body, action.region);
  const content = Buffer.from(next.content, 'utf8');

  if (currentBody !== null && currentBody.trim() === action.body.trim()) {
    return { action, op: 'skip-identical', content, hash };
  }
  const recordedHash = wholeFileHash(manifest, action.dest);
  // A block still under the legacy markers was recorded by an older houserules generation whose
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
    return { action, op: 'skip-modified', content, hash };
  }
  pendingContent.set(action.dest, next.content);
  if (next.status === 'created') {
    return { action, op: 'create', content, hash };
  }
  return {
    action,
    op: 'update',
    content,
    hash,
    ...(currentBody !== null && { previousBody: currentBody }),
  };
}

/**
 * houserules owns everything below the closing `---` in a `body`-owned file. Splits
 * frontmatter (which may be user-trimmed) from the body (fully kit-owned) and judges
 * each half against its own recorded hash.
 *
 * @returns Null when the action's payload file is missing, meaning the caller should skip it.
 */
function effectForBody(
  action: BodyAction,
  destAbs: string,
  exists: boolean,
  manifest: HouseManifest | null,
  force: boolean,
  plugins: PluginSource[] | undefined,
  broken: Map<string, string[]>,
  brokenDests: Set<string>,
): Effect | null {
  if (checkPayloadMissing(action, plugins, broken, brokenDests)) return null;
  const shipped = readFileSync(action.src, 'utf8');
  const { frontmatter: shippedFrontmatter, body: payloadBody } =
    splitFrontmatter(shipped);
  // The kit-owned body is the payload's plus whatever the module computed from the
  // user's selections, so the hash covers both and a changed selection refreshes it.
  const canonicalBody = payloadBody + (action.appendBody ?? '');
  const hash = sha256(canonicalBody);
  const frontmatterHash = sha256(shippedFrontmatter);

  if (!exists) {
    return {
      action,
      op: 'create',
      content: Buffer.from(shippedFrontmatter + canonicalBody, 'utf8'),
      hash,
      frontmatterHash,
    };
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
    return { action, op: 'skip-identical', content, hash, frontmatterHash };
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
    return { action, op: 'skip-modified', content, hash, frontmatterHash };
  }
  return { action, op: 'update', content, hash, frontmatterHash };
}

/**
 * A user-owned file, written only when absent, except for the `managedKeys` splice
 * described on {@link SeedAction}.
 */
function effectForSeed(
  action: SeedAction,
  destAbs: string,
  exists: boolean,
  pendingContent: Map<string, string>,
): Effect {
  if (!exists) pendingContent.set(action.dest, action.content);
  // A seed with managedKeys reconciles those keys into a file that already exists. Every
  // other byte, including the user's edits to the managed keys' neighbors, is preserved.
  const mergedText =
    exists && action.managedKeys?.length
      ? mergeManagedKeys(
          readFileSync(destAbs, 'utf8'),
          action.content,
          action.managedKeys,
        )
      : null;
  if (mergedText !== null) {
    return { action, op: 'merge', content: Buffer.from(mergedText, 'utf8') };
  }
  return {
    action,
    op: exists ? 'skip-exists' : 'create',
    content: exists ? null : Buffer.from(action.content, 'utf8'),
  };
}

/**
 * A kit-owned file end to end: refreshed whenever the canonical bytes change, unless a
 * hash mismatch against the manifest says you edited it.
 *
 * @returns Null when a `copy` dupes a dest/src pair already planned this run (core and a
 *   plugin sidecar independently deriving the same shared lib), or when its payload file
 *   is missing.
 */
function effectForCopyOrWrite(
  action: CopyAction | WriteAction,
  root: string,
  destAbs: string,
  exists: boolean,
  manifest: HouseManifest | null,
  force: boolean,
  plugins: PluginSource[] | undefined,
  broken: Map<string, string[]>,
  brokenDests: Set<string>,
  seenCopySrc: Map<string, string>,
  generatedDirs: string[],
): Effect | null {
  // dest → src of the copy already planned there. Core hand-lists every shared lib
  // unconditionally (modules/core.ts), and a plugin's sidecar independently derives a copy
  // of the same lib from the same CLI payload, so the two actions are byte-identical: same
  // dest, same src, different `module`. Deduping only when both match is what keeps this
  // safe for a genuine dest collision between two DIFFERENT sources, which stays a bug this
  // does not paper over.
  if (action.kind === 'copy') {
    if (seenCopySrc.get(action.dest) === action.src) return null;
    seenCopySrc.set(action.dest, action.src);
    if (checkPayloadMissing(action, plugins, broken, brokenDests)) return null;
  }
  const content = readAction(action);
  const hash = sha256(content);
  const op = classifyWrite({
    exists,
    onDisk: exists ? readFileSync(destAbs) : null,
    canonical: content,
    recordedHash: wholeFileHash(manifest, action.dest),
    force,
    isGenerated: isGeneratedDest(action.dest, generatedDirs),
  });
  return { action, op, content, hash };
}

/**
 * All modules' settings fragments merged into one pass over the real file.
 *
 * @throws HouseError when the existing `.claude/settings.json` is not valid JSON, since the
 *   houserules refuses to rewrite a file it cannot parse.
 */
function computeSettingsPlan(
  root: string,
  fragments: SettingsFragment[],
): SettingsPlan | null {
  if (!fragments.length) return null;
  const settingsPath = join(root, '.claude', 'settings.json');
  const existedBefore = existsSync(settingsPath);
  let current: Settings = {};
  if (existedBefore) {
    const text = readFileSync(settingsPath, 'utf8');
    try {
      current = parseSettingsText(text);
    } catch (e) {
      throw new HouseError(
        `.claude/settings.json is not valid JSON (${(e as Error).message}). ` +
          'Fix it by hand first. houserules will not rewrite a file it cannot parse.',
        { cause: e },
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
  return {
    dest: '.claude/settings.json',
    existedBefore,
    changes: allChanges,
    text: renderSettings(merged),
  };
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
  {
    manifest = null,
    force = false,
    plugins,
    shouldPlanPrepare = false,
  }: ComputeEffectsOptions = {},
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
  const seenCopySrc = new Map<string, string>();
  const generatedDirs = generatedDirsIn(actions);

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

    let effect: Effect | null;
    if (action.kind === 'region') {
      effect = effectForRegion(
        action,
        destAbs,
        exists,
        manifest,
        force,
        pendingContent,
      );
    } else if (action.kind === 'body') {
      effect = effectForBody(
        action,
        destAbs,
        exists,
        manifest,
        force,
        plugins,
        broken,
        brokenDests,
      );
    } else if (action.kind === 'seed') {
      effect = effectForSeed(action, destAbs, exists, pendingContent);
    } else {
      effect = effectForCopyOrWrite(
        action,
        root,
        destAbs,
        exists,
        manifest,
        force,
        plugins,
        broken,
        brokenDests,
        seenCopySrc,
        generatedDirs,
      );
    }
    if (effect) effects.push(effect);
  }

  const settingsPlan = computeSettingsPlan(root, fragments);

  // houserules' settings signature is recorded even on a no-change run (the fragments
  // describe houserules' contribution regardless of what's already merged in).
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
    ...(shouldPlanPrepare && { prepareScript: planPrepareScript(root) }),
    advisories,
    signature,
    fragments,
    plannedDests,
    brokenPlugins,
  };
}

type RetiredEntryVerdict =
  { kind: 'gone' } | { kind: 'keep' } | { kind: 'delete'; modified: boolean };

/**
 * Judges one retired manifest entry by `lstat`, so a link is judged as itself. A dangling link
 * is a delete, never gone, since `existsSync` would follow it and leave it on disk. A link to a
 * directory is never read and counts as modified. A link to a file is hashed through the link.
 */
function judgeRetiredEntry(
  absolutePath: string,
  hash: HouseManifest['files'][string],
  force: boolean,
): RetiredEntryVerdict {
  const entry = lstatSync(absolutePath, { throwIfNoEntry: false });
  if (entry === undefined) return { kind: 'gone' };
  const target = entry.isSymbolicLink()
    ? statSync(absolutePath, { throwIfNoEntry: false })
    : entry;
  if (target === undefined) return { kind: 'delete', modified: false };
  if (target.isDirectory()) {
    return force ? { kind: 'delete', modified: true } : { kind: 'keep' };
  }
  const modified =
    typeof hash === 'object'
      ? sha256(splitFrontmatter(readFileSync(absolutePath, 'utf8')).body) !==
        hash.body
      : sha256(readFileSync(absolutePath)) !== hash;
  if (modified && !force) return { kind: 'keep' };
  return { kind: 'delete', modified };
}

/**
 * Manifest-diff prune, used by `update`. A file the previous manifest recorded as
 * kit-owned but the current plan no longer produces is retired. Only kit-owned,
 * hash-unmodified files are deleted. A locally edited one is kept and warned about
 * unless `force`. A file already gone is just dropped from the manifest. A symlink is
 * judged as itself, see `judgeRetiredEntry`.
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
    manifest?: HouseManifest | null;
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
    const verdict = judgeRetiredEntry(join(root, dest), hash, force);
    if (verdict.kind === 'gone') deletes.push({ dest, gone: true });
    else if (verdict.kind === 'keep') kept.push(dest);
    else deletes.push({ dest, modified: verdict.modified });
  }

  // Retired scripts (that a hook might still reference). Surfaced for unwiring.
  const removedScripts = deletes
    .filter((d) => /^\.claude\/scripts\/.+\.mjs$/.test(d.dest))
    .map((d) => d.dest.split('/').pop())
    .filter((name): name is string => name !== undefined);

  return { deletes, kept, removedScripts };
}
