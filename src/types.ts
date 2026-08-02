import type { Except } from 'type-fest';
import type { KitConfig, KitConfigTarget } from './core/config.js';
import type { RegionSpec, UpsertStatus } from './core/regions.js';

export type { RegionSpec, UpsertStatus };
import type {
  PackageJson,
  WorkspacePackage,
} from '../payload-dist/scripts/lib/workspaces.mjs';

export type { PackageJson, WorkspacePackage };

/** How the package manager was identified. Shown in the profile card. */
export type PackageManagerSource = 'packageManager' | 'lockfile' | 'default';

export interface PackageManagerInfo {
  name: string;
  version?: string;
  source: PackageManagerSource;
}

/**
 * A unit of the repo the kit tracks: a workspace package, or the repo itself for a
 * single-package repo. Detection proposes these. `kit.config.json` is the contract
 * once the user has edited it.
 *
 * It is deliberately the SAME type as a config target rather than a near-duplicate.
 * `update`/`modules` prefer `kitConfig.targets` and fall back to detection's, so the
 * two are used interchangeably. Declaring them separately only invited them to
 * drift on optionality. Per-field documentation lives on the zod schema's
 * `.describe()` calls in `core/config.ts`.
 */
export type Target = KitConfigTarget;

export type ChangesetInvocation =
  'devdep' | 'root-script' | 'external-cli' | 'absent';

export interface ChangesetsState {
  configExists: boolean;
  config: Record<string, unknown> | null;
  pendingCount: number;
  devDep: boolean;
  rootScript: string | null;
  invocation: ChangesetInvocation;
  baseBranch: string;
}

export interface GitState {
  isRepo: boolean;
  top: string | null;
  hasCommits: boolean;
  branch: string | null;
}

export interface ClaudeState {
  dirExists: boolean;
  settingsExists: boolean;
  settings: Settings | null;
  /** Message from a failed settings.json parse. Null when it parsed or is absent. */
  settingsParseError: string | null;
  settingsLocalExists: boolean;
  claudeMdExists: boolean;
  manifest: KitManifest | null;
  kitConfig: KitConfig | null;
  agents: string[];
  skills: string[];
}

/** Everything `detect()` concluded, read-only. The sole input to module decisions. */
export interface Ctx {
  root: string;
  git: GitState;
  packageManager: PackageManagerInfo | null;
  rootPkg: PackageJson | null;
  isMonorepo: boolean;
  packages: WorkspacePackage[];
  targets: Target[];
  typescript: boolean;
  changesets: ChangesetsState;
  pnpmCatalogModeStrict: boolean;
  claude: ClaudeState;
}

/** What the user chose (interactively or via flags). The second module input. */
export interface Answers {
  moduleIds: string[];
  targets: Target[];
  seedChangesetConfig: boolean;
  /**
   * Narrows which targets get a reviewer draft. No caller sets it today. The
   * reviewers module falls back to every target. But it is the module's declared
   * extension point, so it belongs in the seam rather than in a local intersection.
   */
  reviewerTargets?: string[];
}

/**
 * What a module declares should exist. Modules never touch the filesystem. They
 * return these and the plan engine turns them into Effects.
 *
 * - `copy`  kit-owned file sourced from payload/
 * - `write` kit-owned file with generated content
 * - `seed`  user-owned: written only when absent, never refreshed or overwritten
 * - `merge-settings` a fragment folded into .claude/settings.json
 * - `advise` a line for the post-install next-steps checklist
 */
export type ActionKind =
  'copy' | 'write' | 'seed' | 'region' | 'merge-settings' | 'advise';

interface ActionBase {
  /** id of the module that declared it, for reporting and manifest attribution. */
  module: string;
}

export interface CopyAction extends ActionBase {
  kind: 'copy';
  /** Absolute path under payload/. */
  src: string;
  /** Repo-relative destination. */
  dest: string;
  mode?: number;
  reason: string;
}

export interface WriteAction extends ActionBase {
  kind: 'write';
  dest: string;
  content: string;
  mode?: number;
  reason: string;
}

export interface SeedAction extends ActionBase {
  kind: 'seed';
  dest: string;
  content: string;
  reason: string;
}

/**
 * A marker-delimited block inside a file the USER owns. The kit rewrites only what
 * is between the markers. Everything else in the host file survives verbatim. The
 * manifest records a hash of the BODY (not the file), so a hand-edited region is
 * detectable as a local edit while the user's own prose around it is irrelevant.
 */
export interface RegionAction extends ActionBase {
  kind: 'region';
  dest: string;
  /** The managed content, without markers. */
  body: string;
  region: RegionSpec;
  reason: string;
}

export interface MergeSettingsAction extends ActionBase {
  kind: 'merge-settings';
  fragment: SettingsFragment;
}

export interface AdviseAction extends ActionBase {
  kind: 'advise';
  text: string;
}

export type Action =
  | CopyAction
  | WriteAction
  | SeedAction
  | RegionAction
  | MergeSettingsAction
  | AdviseAction;

/** The actions that name a destination path. Everything except advise/settings. */
export type FileAction = CopyAction | WriteAction | SeedAction | RegionAction;

/** Narrowing helper: file actions are the ones with a `dest`. */
export function isFileAction(action: Action): action is FileAction {
  return (
    action.kind === 'copy' ||
    action.kind === 'write' ||
    action.kind === 'seed' ||
    action.kind === 'region'
  );
}

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
 * written around it.
 */
export type EffectOp =
  | 'create'
  | 'update'
  | 'skip-identical'
  | 'skip-exists'
  | 'skip-modified'
  | 'delete';

export interface Effect {
  action: FileAction;
  op: EffectOp;
  /** Bytes to write. Null for a skipped seed. */
  content: Buffer | null;
  /** sha256 of `content`, recorded in the manifest for kit-owned files. */
  hash?: string;
}

export interface HookEntry {
  type: 'command';
  command: string;
  statusMessage?: string;
  [key: string]: unknown;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

export interface Permissions {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

/** A .claude/settings.json document. Unknown keys pass through untouched. */
export interface Settings {
  permissions?: Permissions;
  hooks?: Record<string, HookGroup[]>;
  statusLine?: unknown;
  outputStyle?: string;
  [key: string]: unknown;
}

/** A module's contribution to settings.json. Additive by construction. */
export interface SettingsFragment {
  permissions?: Permissions;
  hooks?: Record<string, HookGroup[]>;
  statusLine?: unknown;
  [key: string]: unknown;
}

export type SettingsChangeKind =
  'permission' | 'hook' | 'remove-hook' | 'statusLine';

export interface SettingsChange {
  kind: SettingsChangeKind;
  detail: string;
}

export interface SettingsPlan {
  dest: string;
  existedBefore: boolean;
  changes: SettingsChange[];
  /** Rendered file text. Absent only on a plan built purely to carry removals. */
  text?: string;
}

/** The hooks + permissions the kit contributed, recorded so update/doctor can
 * reconcile precisely instead of guessing which entries are the kit's. */
export interface SettingsSignature {
  hooks: { event: string; matcher: string | null; script: string | null }[];
  permissions: string[];
}

/** The receipt `.claude/kit-manifest.json`: what the kit installed and at what hash. */
export interface KitManifest {
  kitVersion: string;
  installedAt: string;
  modules: string[];
  /** repo-relative dest → sha256 of the content the kit wrote. */
  files: Record<string, string>;
  settings?: SettingsSignature;
}

/**
 * `.claude/kit.config.json`: user-owned, seeded once and never overwritten.
 * Inferred from the zod schema in `core/config.ts`, so the validator and the type
 * cannot drift. The payload consumes this as a type-only import (zod is erased at
 * build and never reaches a user's repo).
 */
export type { KitConfig, KitConfigTarget };

/**
 * Which section of the interactive multiselect a module appears under.
 * `experimental` is supported by the picker (it prefixes the hint with a warning)
 * but no module currently declares it. Keep it, so shipping one is a one-word change.
 */
export type ModuleGroup = 'recommended' | 'optional' | 'experimental';

/**
 * A capability unit. Modules are pure: `plan()` decides from `ctx` + `answers` and
 * returns actions. `locked` modules (core) cannot be deselected or disabled.
 */
export interface ModuleDef {
  id: string;
  title: string;
  group: ModuleGroup;
  locked?: boolean;
  /** One-line rationale shown next to the checkbox. */
  hint(ctx: Ctx): string;
  defaultEnabled(ctx: Ctx): boolean;
  plan(ctx: Ctx, answers: Answers): Action[];
}

export interface ComputeEffectsOptions {
  manifest?: KitManifest | null;
  force?: boolean;
}

export interface PlanResult {
  effects: Effect[];
  settingsPlan: SettingsPlan | null;
  advisories: AdviseAction[];
  signature: SettingsSignature;
  /** Every dest the current plan produces. The reference set prune diffs against. */
  plannedDests: Set<string>;
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

/**
 * What apply() consumes: a plan result minus the fields it has no use for, plus the
 * prune. Derived from `PlanResult` rather than restated, so a field added there
 * cannot silently go unconsidered here. `signature` widens to optional because a
 * caller may apply without recording one.
 */
export type ApplyInput = Except<
  PlanResult,
  'advisories' | 'plannedDests' | 'signature'
> & {
  signature?: SettingsSignature | null;
  prune?: PruneResult | null;
};

export interface ApplyOptions {
  kitVersion: string;
  moduleIds: string[];
  previousManifest?: KitManifest | null;
  /** Restrict writes to these dests (doctor --fix). Omit to write the whole plan. */
  paths?: Set<string>;
}

export interface WrittenEntry {
  dest: string;
  op: EffectOp | 'merge';
}

export interface ApplyResult {
  written: WrittenEntry[];
  manifest: KitManifest;
}

export interface Flags {
  dryRun: boolean;
  yes: boolean;
  modules: string;
  force: boolean;
  nextSteps: boolean;
  /** `modules` only: comma-separated ids to withdraw from the install. */
  disable: string;
  /** `doctor` only: reconcile the drift found, instead of only reporting it. */
  fix: boolean;
  /** `doctor --fix` only: also delete orphaned kit files. */
  prune: boolean;
  /** Machine-readable output on stdout. Human text goes to stderr. */
  json: boolean;
  kitVersion: string;
}

/**
 * The exit-code contract, printed in `--help` and asserted in `src/__test__/cli.test.ts`.
 * There is deliberately no "refused to overwrite" code: `init` on an existing
 * install re-plans from the recorded module set rather than refusing.
 */
export const EXIT = {
  ok: 0,
  /** A command failed, or `doctor` found an ERROR-level problem. */
  error: 1,
  /** `.claude/kit.config.json` does not satisfy the schema. */
  badConfig: 2,
} as const;
