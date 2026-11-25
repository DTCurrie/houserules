import { planPrepareScript, type PrepareScriptPlan } from './prepare-script.js';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';

import {
  HOOK_DISPATCH_SCRIPT,
  HOOK_WIRING_PATH,
  isKitStockCommand,
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
import { fallbackForEvent, hookCommand } from '@houserules/api';
import { HouseError } from './house-error.js';
import { mergeManagedKeys } from './merge-config-keys.js';
import {
  classifyFrontmatter,
  renderFrontmatterPaths,
  splitFrontmatter,
} from './core/frontmatter.js';

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
  HookEntry,
  HookGroup,
  HouseConfig,
  ModuleDef,
  Settings,
  SettingsFragment,
} from '@houserules/api';
import type {
  HookWiring,
  HookWiringEntry,
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
  /**
   * An ejected dest that exists with no recorded hash: the canonical hash this plan judged
   * it against in place of the missing record, the body half's for a `body` action.
   * `apply()` records it for a `skip-modified` dest the previous manifest lacks, so a clone's
   * first sync keeps the teammate's edit and a later kit bump reads `conflict`.
   */
  substitutedHash?: string;
}

/**
 * The ownership choices the config records past the module set, read by every plan and
 * prune so `update`, `doctor`, `modules`, and `init` judge a file the same way.
 */
export interface ConfigOwnership {
  /**
   * Repo-relative dests the config's `ejected` lists. Planned as a committed file is, an
   * edit is never overwritten, not even under `force`, and the file is never pruned.
   */
  ejected?: ReadonlySet<string>;
  /**
   * Rule id → the `paths:` the config's `rules` sets for it. A rule id is the file name
   * under `.claude/rules/` without `.md`. Rendered into that rule's frontmatter.
   */
  rulePaths?: Readonly<Record<string, readonly string[]>>;
}

/** The {@link ConfigOwnership} a config records. A missing config owns nothing. */
export function configOwnership(
  config: HouseConfig | null | undefined,
): Required<ConfigOwnership> {
  const rulePaths: Record<string, readonly string[]> = {};
  for (const [ruleId, settings] of Object.entries(config?.rules ?? {})) {
    if (settings.paths !== undefined) rulePaths[ruleId] = settings.paths;
  }
  return { ejected: new Set(config?.ejected ?? []), rulePaths };
}

export interface ComputeEffectsOptions extends ConfigOwnership {
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
   * The settings fragments this run merges: every module's, minus the hooks the dispatcher
   * runs, then one dispatcher fragment per event. Exposed so a caller can reconcile a
   * previously recorded {@link SettingsSignature} against what is CURRENTLY declared, such
   * as `update`'s stale-hook cleanup, which is what drops a pre-dispatch per-script entry.
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
  /**
   * Ejected dests on disk that no current module plans, kept whatever their bytes, under
   * `force` too. Read from the config's `ejected` list as well as the manifest, so a clone
   * with no manifest still finds them.
   */
  ejected: string[];
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

/** The `paths:` the config sets for the rule installed at `dest`, or undefined for none. */
function configPathsFor(
  dest: string,
  rulePaths: Readonly<Record<string, readonly string[]>>,
): readonly string[] | undefined {
  const ruleId = /^\.claude\/rules\/(.+)\.md$/.exec(dest)?.[1];
  if (ruleId === undefined || !Object.hasOwn(rulePaths, ruleId))
    return undefined;
  return rulePaths[ruleId];
}

/**
 * houserules owns everything below the closing `---` in a `body`-owned file. Splits
 * frontmatter (which may be user-trimmed) from the body (fully kit-owned) and judges
 * each half against its own recorded hash.
 *
 * @param configPaths The `paths:` the config sets for this rule. When present the config
 *   owns the frontmatter, so it is the shipped one with `paths:` rendered in, written on a
 *   create and a refresh alike. The recorded default stays the shipped frontmatter's hash.
 * @returns Null when the action's payload file is missing, meaning the caller should skip it.
 */
function effectForBody(
  action: BodyAction,
  destAbs: string,
  exists: boolean,
  manifest: HouseManifest | null,
  force: boolean,
  isEjected: boolean,
  configPaths: readonly string[] | undefined,
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
  const renderedFrontmatter =
    configPaths === undefined
      ? undefined
      : renderFrontmatterPaths(shippedFrontmatter, configPaths);

  if (!exists) {
    return {
      action,
      op: 'create',
      content: Buffer.from(
        (renderedFrontmatter ?? shippedFrontmatter) + canonicalBody,
        'utf8',
      ),
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
    renderedFrontmatter ??
    (frontmatterState === 'default' ? shippedFrontmatter : diskFrontmatter);
  const content = Buffer.from(resolvedFrontmatter + canonicalBody, 'utf8');

  if (resolvedFrontmatter + canonicalBody === diskText) {
    return { action, op: 'skip-identical', content, hash, frontmatterHash };
  }

  const recordedBody = bodyHashes(manifest, action.dest);
  const recordedWholeFile = wholeFileHash(manifest, action.dest);
  // A clone has no manifest, and a body with no record would read as unmodified, so an
  // ejected one is judged against the canonical body instead and a teammate's edit is kept.
  const substitutedHash =
    isEjected && recordedBody === undefined && recordedWholeFile === undefined
      ? hash
      : undefined;
  let locallyModified: boolean;
  if (recordedBody !== undefined) {
    locallyModified = sha256(diskBody) !== recordedBody.body;
  } else if (recordedWholeFile !== undefined) {
    // A legacy manifest entry, written before body ownership existed, holds the
    // hash of the WHOLE file. An untouched install still matches that hash and
    // must adopt cleanly rather than read as modified on its first body-owned update.
    locallyModified = sha256(diskText) !== recordedWholeFile;
  } else {
    locallyModified = substitutedHash !== undefined;
  }

  const substitution = substitutedHash === undefined ? {} : { substitutedHash };
  if (locallyModified && !force) {
    return {
      action,
      op: 'skip-modified',
      content,
      hash,
      frontmatterHash,
      ...substitution,
    };
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
  isEjected: boolean,
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
  const recordedHash = wholeFileHash(manifest, action.dest);
  // `classifyWrite` refreshes a file with no record, which on a clone with no manifest
  // would overwrite a teammate's ejected edit, so the canonical hash stands in for it.
  const substitutedHash =
    isEjected && exists && recordedHash === undefined ? hash : undefined;
  const op = classifyWrite({
    exists,
    onDisk: exists ? readFileSync(destAbs) : null,
    canonical: content,
    recordedHash: recordedHash ?? substitutedHash,
    force,
    isGenerated: isGeneratedDest(action.dest, generatedDirs),
  });
  if (op === 'skip-modified' && substitutedHash !== undefined) {
    return { action, op, content, hash, substitutedHash };
  }
  return { action, op, content, hash };
}

/**
 * The modules' fragments split into what settings.json carries and what the dispatcher reads
 * from {@link HOOK_WIRING_PATH}, so a release that adds or rewires a hook leaves the tracked
 * settings.json alone.
 */
interface HookDispatchPlan {
  /** Each module's fragment minus its dispatched hooks, then one dispatcher fragment per event. */
  settingsFragments: SettingsFragment[];
  /** Null when no fragment carries a dispatchable hook. */
  wiring: HookWiring | null;
}

/** The hook whose fallback runs `update --sync`, which the SessionStart dispatcher inherits. */
const BOOTSTRAP_SCRIPT = 'payload-sync.mjs';
const KIT_SCRIPT_BASENAME_RE = /([\w-]+\.mjs)\b/;
/** Matcher values the harness reads as every input. */
const MATCH_EVERY_INPUT = new Set(['', '*']);

/** The `.mjs` basename a hook's command names, or undefined when it names none. */
function kitScriptOf(hook: HookEntry): string | undefined {
  return KIT_SCRIPT_BASENAME_RE.exec(String(hook.command ?? ''))?.[1];
}

/**
 * The script a hook runs through the dispatcher, or null for one that stays a direct
 * settings entry: a hook with `if` or `async`, which the dispatcher cannot honor, or a
 * command houserules' `hookCommand` did not build.
 */
function dispatchedScriptOf(hook: HookEntry): string | null {
  if (hook.if !== undefined || hook.async !== undefined) return null;
  const script = kitScriptOf(hook);
  if (script === undefined || !isKitStockCommand(hook.command, script))
    return null;
  return script;
}

function wiringEntryFor(
  script: string,
  group: HookGroup,
  hook: HookEntry,
): HookWiringEntry {
  return {
    script,
    ...(group.matcher !== undefined && { matcher: group.matcher }),
    ...(hook.timeout !== undefined && { timeout: hook.timeout }),
    ...(hook.onFailure !== undefined && { onFailure: hook.onFailure }),
    ...(hook.statusMessage !== undefined && {
      statusMessage: hook.statusMessage,
    }),
  };
}

/**
 * Moves a fragment's dispatchable hooks into `events`, first declaration of a script per
 * event winning as `mergeSettings` did, and returns the fragment with what remains.
 */
function withoutDispatchedHooks(
  fragment: SettingsFragment,
  events: Record<string, HookWiringEntry[]>,
  editedScripts: ReadonlyMap<string, ReadonlySet<string>>,
): SettingsFragment {
  if (!fragment.hooks) return fragment;
  collectDispatchedHooks(fragment.hooks, events, editedScripts);
  return withDirectHooksOnly(fragment);
}

function collectDispatchedHooks(
  hooks: Record<string, HookGroup[]>,
  events: Record<string, HookWiringEntry[]>,
  editedScripts: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        const script = dispatchedScriptOf(hook);
        if (script === null) continue;
        if (editedScripts.get(event)?.has(script)) continue;
        const entries = (events[event] ??= []);
        if (!entries.some((entry) => entry.script === script))
          entries.push(wiringEntryFor(script, group, hook));
      }
    }
  }
}

/** The fragment with every hook the dispatcher runs removed, and empty groups and events dropped. */
function withDirectHooksOnly(fragment: SettingsFragment): SettingsFragment {
  const directHooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(fragment.hooks ?? {})) {
    const keptGroups: HookGroup[] = [];
    for (const group of groups) {
      const direct = group.hooks.filter(
        (hook) => dispatchedScriptOf(hook) === null,
      );
      if (direct.length) keptGroups.push({ ...group, hooks: direct });
    }
    if (keptGroups.length) directHooks[event] = keptGroups;
  }
  const residual: SettingsFragment = { ...fragment };
  delete residual.hooks;
  if (Object.keys(directHooks).length) residual.hooks = directHooks;
  return residual;
}

/**
 * Splits a matcher on its top-level `|`, leaving an alternation inside a regex group or
 * character class whole, so `mcp__(a|b)__x|Bash` yields two alternatives, not three.
 */
function matcherAlternatives(matcher: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < matcher.length; index++) {
    const char = matcher[index];
    if (char === '\\') index++;
    else if (char === '(' || char === '[') depth++;
    else if ((char === ')' || char === ']') && depth > 0) depth--;
    else if (char === '|' && depth === 0) {
      alternatives.push(matcher.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(matcher.slice(start));
  return alternatives.filter((alternative) => alternative !== '');
}

/**
 * The dispatcher entry's matcher: the sorted, deduped union of its hooks' alternatives, or
 * null when any hook matches every input, since the entry must then fire on every input too.
 */
function dispatcherMatcher(entries: HookWiringEntry[]): string | null {
  const alternatives = new Set<string>();
  for (const { matcher } of entries) {
    if (matcher === undefined || MATCH_EVERY_INPUT.has(matcher)) return null;
    for (const alternative of matcherAlternatives(matcher))
      alternatives.add(alternative);
  }
  return [...alternatives].sort().join('|');
}

/** The harness's default timeout for a command hook, in seconds. */
const HARNESS_TIMEOUT_SECONDS = 600;
/**
 * The events on which the harness lowers that default. Mirrors `EVENT_TIMEOUT_SECONDS` in the
 * payload's `hook-dispatch.mts`, which cannot import from here.
 */
const EVENT_TIMEOUT_SECONDS: Readonly<Record<string, number>> = {
  UserPromptSubmit: 30,
  PreModelSwitch: 30,
  PostModelSwitch: 30,
  MessageDisplay: 10,
  SessionEnd: 1.5,
};
/** Seconds the dispatcher gets past its slowest hook to merge the outputs and exit. */
const DISPATCH_MARGIN_SECONDS = 2;

/**
 * The `timeout` the dispatcher entry of `event` needs so the harness does not kill it before
 * its slowest wired hook times out, or null when the harness default already covers it.
 */
function dispatcherTimeout(
  event: string,
  entries: HookWiringEntry[],
): number | null {
  const slowest = Math.max(0, ...entries.map((entry) => entry.timeout ?? 0));
  if (slowest === 0) return null;
  const harnessDefault = Object.hasOwn(EVENT_TIMEOUT_SECONDS, event)
    ? EVENT_TIMEOUT_SECONDS[event]!
    : HARNESS_TIMEOUT_SECONDS;
  const needed = slowest + DISPATCH_MARGIN_SECONDS;
  return needed > harnessDefault ? needed : null;
}

/** The one settings entry that runs every dispatched hook of `event`. */
function dispatcherFragment(
  event: string,
  entries: HookWiringEntry[],
): SettingsFragment {
  const isBootstrap =
    event === 'SessionStart' &&
    entries.some((entry) => entry.script === BOOTSTRAP_SCRIPT);
  const hook: HookEntry = {
    type: 'command',
    command: hookCommand(
      HOOK_DISPATCH_SCRIPT,
      isBootstrap ? 'bootstrap' : fallbackForEvent(event),
    ),
  };
  if (entries.some((entry) => entry.onFailure === 'block'))
    hook.onFailure = 'block';
  const timeout = dispatcherTimeout(event, entries);
  if (timeout !== null) hook.timeout = timeout;
  const matcher = dispatcherMatcher(entries);
  const group: HookGroup =
    matcher === null ? { hooks: [hook] } : { matcher, hooks: [hook] };
  return { hooks: { [event]: [group] } };
}

/**
 * Per event, the kit scripts the existing settings already run through a command the user
 * edited. Dispatching the stock hook of such a script would run it twice.
 */
function editedScriptsByEvent(settings: Settings): Map<string, Set<string>> {
  const edited = new Map<string, Set<string>>();
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group?.hooks ?? []) {
        const script = kitScriptOf(hook);
        if (script === undefined || isKitStockCommand(hook.command, script))
          continue;
        const scripts = edited.get(event) ?? new Set<string>();
        scripts.add(script);
        edited.set(event, scripts);
      }
    }
  }
  return edited;
}

/** Splits the modules' fragments into settings entries and dispatcher wiring. */
function planHookDispatch(
  fragments: SettingsFragment[],
  existing: Settings,
): HookDispatchPlan {
  const events: Record<string, HookWiringEntry[]> = {};
  const editedScripts = editedScriptsByEvent(existing);
  const residual = fragments.map((fragment) =>
    withoutDispatchedHooks(fragment, events, editedScripts),
  );
  const dispatchers = Object.entries(events).map(([event, entries]) =>
    dispatcherFragment(event, entries),
  );
  return {
    settingsFragments: [...residual, ...dispatchers],
    wiring: Object.keys(events).length ? { version: 1, events } : null,
  };
}

/** The generated write that puts the wiring where the dispatcher reads it. */
function hookWiringAction(wiring: HookWiring): WriteAction {
  return {
    kind: 'write',
    module: 'core',
    dest: HOOK_WIRING_PATH,
    content: `${JSON.stringify(wiring, null, 2)}\n`,
    reason: 'the hooks each event dispatcher runs',
  };
}

function hookLabel(event: string, group: HookGroup, script: string): string {
  return `${event}${group.matcher ? `(${group.matcher})` : ''}: ${script}`;
}

/**
 * Drops a per-script entry the dispatcher now runs for the same event, so an install wired
 * before dispatch does not run the hook twice. Only a command houserules itself would emit
 * is dropped. A user's edited variant stays, and a group or event nothing was dropped from
 * keeps its exact shape.
 */
function dropDispatchedStockHooks(
  settings: Settings,
  wiring: HookWiring,
  changes: SettingsChange[],
): void {
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const dispatched = new Set(
      (wiring.events[event] ?? []).map((entry) => entry.script),
    );
    if (!dispatched.size) continue;
    let hasDroppedAny = false;
    const keptGroups: HookGroup[] = [];
    for (const group of groups ?? []) {
      const kept = (group?.hooks ?? []).filter((hook) => {
        const script = kitScriptOf(hook);
        if (script === undefined || !dispatched.has(script)) return true;
        if (!isKitStockCommand(hook.command, script)) return true;
        changes.push({
          kind: 'remove-hook',
          detail: `${hookLabel(event, group, script)} (now dispatched)`,
        });
        hasDroppedAny = true;
        return false;
      });
      if (kept.length === (group?.hooks ?? []).length) keptGroups.push(group);
      else if (kept.length) keptGroups.push({ ...group, hooks: kept });
    }
    if (!hasDroppedAny) continue;
    if (keptGroups.length) settings.hooks![event] = keptGroups;
    else delete settings.hooks![event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length)
    delete settings.hooks;
}

function isDispatcherHook(hook: HookEntry): boolean {
  return isKitStockCommand(hook.command, HOOK_DISPATCH_SCRIPT);
}

/**
 * Moves an existing dispatcher entry onto the matcher its event's hooks now need. The
 * command does not change with the matcher, so `mergeSettings` would read the entry as
 * present and leave a hook whose tool the old matcher misses unrun. A group holding only the
 * dispatcher is rewritten in place. One shared with other hooks loses the dispatcher, and
 * the merge then adds it under the right matcher.
 */
function alignDispatcherMatchers(
  settings: Settings,
  wiring: HookWiring,
  changes: SettingsChange[],
): void {
  for (const [event, entries] of Object.entries(wiring.events)) {
    const desired = dispatcherMatcher(entries);
    const groups = settings.hooks?.[event] ?? [];
    groups.forEach((group, index) => {
      if (!group?.hooks?.some(isDispatcherHook)) return;
      if ((group.matcher ?? null) === desired) return;
      if (group.hooks.length > 1) {
        group.hooks = group.hooks.filter((hook) => !isDispatcherHook(hook));
        return;
      }
      const rest: HookGroup = { ...group };
      delete rest.matcher;
      groups[index] = desired === null ? rest : { matcher: desired, ...rest };
      changes.push({
        kind: 'hook',
        detail: `${event}: ${HOOK_DISPATCH_SCRIPT} matcher ${group.matcher ?? '(every input)'} → ${desired ?? '(every input)'}`,
      });
    });
  }
}

/**
 * The existing `.claude/settings.json`, or an empty one when absent.
 *
 * @throws HouseError when the file is not valid JSON, since houserules refuses to rewrite a
 *   file it cannot parse.
 */
function readExistingSettings(root: string): {
  settings: Settings;
  existedBefore: boolean;
} {
  const settingsPath = join(root, '.claude', 'settings.json');
  if (!existsSync(settingsPath)) return { settings: {}, existedBefore: false };
  try {
    return {
      settings: parseSettingsText(readFileSync(settingsPath, 'utf8')),
      existedBefore: true,
    };
  } catch (e) {
    throw new HouseError(
      `.claude/settings.json is not valid JSON (${(e as Error).message}). ` +
        'Fix it by hand first. houserules will not rewrite a file it cannot parse.',
      { cause: e },
    );
  }
}

/**
 * All modules' settings fragments merged into one pass over the real file.
 *
 * @param wiring The dispatched hooks, whose pre-dispatch per-script entries are dropped and
 *   whose dispatcher entries are moved onto the current matcher before the merge.
 * @throws HouseError when the existing `.claude/settings.json` is not valid JSON, since the
 *   houserules refuses to rewrite a file it cannot parse.
 */
function computeSettingsPlan(
  fragments: SettingsFragment[],
  wiring: HookWiring | null,
  current: Settings,
  existedBefore: boolean,
): SettingsPlan | null {
  if (!fragments.length) return null;
  const allChanges: SettingsChange[] = [];
  let merged = current;
  if (wiring) {
    dropDispatchedStockHooks(merged, wiring, allChanges);
    alignDispatcherMatchers(merged, wiring, allChanges);
  }
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

interface HookWiringEffectContext {
  manifest: HouseManifest | null;
  force: boolean;
  ejected: ReadonlySet<string>;
  plugins: PluginSource[] | undefined;
  broken: Map<string, string[]>;
  brokenDests: Set<string>;
  seenCopySrc: Map<string, string>;
  generatedDirs: string[];
}

/** The effect that writes the dispatcher wiring file, judged as any other kit-owned write is. */
function hookWiringEffectFor(
  wiring: HookWiring,
  root: string,
  context: HookWiringEffectContext,
): Effect | null {
  const isEjected = context.ejected.has(HOOK_WIRING_PATH);
  return effectForCopyOrWrite(
    hookWiringAction(wiring),
    root,
    join(root, HOOK_WIRING_PATH),
    existsSync(join(root, HOOK_WIRING_PATH)),
    context.manifest,
    context.force && !isEjected,
    isEjected,
    context.plugins,
    context.broken,
    context.brokenDests,
    context.seenCopySrc,
    context.generatedDirs,
  );
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
    ejected = new Set<string>(),
    rulePaths = {},
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
    const isEjected = ejected.has(action.dest);
    // `force` never writes an ejected file: it is planned as it is without the flag.
    const effectiveForce = force && !isEjected;

    let effect: Effect | null;
    if (action.kind === 'region') {
      effect = effectForRegion(
        action,
        destAbs,
        exists,
        manifest,
        effectiveForce,
        pendingContent,
      );
    } else if (action.kind === 'body') {
      effect = effectForBody(
        action,
        destAbs,
        exists,
        manifest,
        effectiveForce,
        isEjected,
        configPathsFor(action.dest, rulePaths),
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
        effectiveForce,
        isEjected,
        plugins,
        broken,
        brokenDests,
        seenCopySrc,
        generatedDirs,
      );
    }
    if (effect) effects.push(effect);
  }

  const existing = fragments.length
    ? readExistingSettings(root)
    : { settings: {}, existedBefore: false };
  const { settingsFragments, wiring } = planHookDispatch(
    fragments,
    existing.settings,
  );
  if (wiring) {
    const wiringEffect = hookWiringEffectFor(wiring, root, {
      manifest,
      force,
      ejected,
      plugins,
      broken,
      brokenDests,
      seenCopySrc,
      generatedDirs,
    });
    if (wiringEffect) effects.push(wiringEffect);
  }

  const settingsPlan = computeSettingsPlan(
    settingsFragments,
    wiring,
    existing.settings,
    existing.existedBefore,
  );

  // houserules' settings signature is recorded even on a no-change run (the fragments
  // describe houserules' contribution regardless of what's already merged in).
  const signature = settingsSignature(settingsFragments);

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
    fragments: settingsFragments,
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
 * judged as itself, see `judgeRetiredEntry`. An ejected file is never deleted, not even
 * under `force`.
 *
 * Pure computation. Only `apply()` writes, and dry-run renders exactly this.
 *
 * @returns The deletions, the retired-but-kept files, the retired ejected files, and the
 * basenames of retired hook scripts so the caller can unwire them.
 */
export function computePrune(
  root: string,
  {
    manifest,
    plannedDests,
    force = false,
    ejected = new Set<string>(),
  }: {
    manifest?: HouseManifest | null;
    plannedDests: Set<string>;
    force?: boolean;
    /** See {@link ConfigOwnership.ejected}. An ejected dest is never deleted. */
    ejected?: ReadonlySet<string>;
  },
): PruneResult {
  const deletes: PruneDelete[] = [];
  const kept: string[] = [];
  const keptEjected: string[] = [];
  for (const [dest, hash] of Object.entries(manifest?.files ?? {})) {
    if (plannedDests.has(dest)) continue; // still produced by a current module
    // A stale manifest entry here would propose deleting the user's CLAUDE.md outright.
    // The recorded hash is the region BODY's, so it would not even read as modified.
    if (SHARED_HOST_FILES.has(dest)) continue;
    const verdict = judgeRetiredEntry(join(root, dest), hash, force);
    if (verdict.kind === 'gone') deletes.push({ dest, gone: true });
    else if (ejected.has(dest)) keptEjected.push(dest);
    else if (verdict.kind === 'keep') kept.push(dest);
    else deletes.push({ dest, modified: verdict.modified });
  }
  // The config, not the manifest, is the record on a clone, which has no manifest until
  // its first sync, so an ejected dest the manifest never listed is found here.
  for (const dest of ejected) {
    if (plannedDests.has(dest) || manifest?.files[dest] !== undefined) continue;
    if (lstatSync(join(root, dest), { throwIfNoEntry: false }) === undefined)
      continue;
    keptEjected.push(dest);
  }

  // Retired scripts (that a hook might still reference). Surfaced for unwiring.
  const removedScripts = deletes
    .filter((d) => /^\.claude\/scripts\/.+\.mjs$/.test(d.dest))
    .map((d) => d.dest.split('/').pop())
    .filter((name): name is string => name !== undefined);

  return { deletes, kept, ejected: keptEjected, removedScripts };
}
