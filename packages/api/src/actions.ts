import type { RegionSpec } from './regions.js';
import type { SettingsFragment } from './merge-settings.js';

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

/**
 * User-owned: written whole only when absent, never refreshed or overwritten.
 *
 * `managedKeys` is the one narrow exception, and it exists because some of what the kit
 * computes has to OUTLIVE the run that computed it. A module's resolved `options` are the
 * case: `update` and `doctor` re-resolve them every run, so a selection that is never written
 * down silently reverts to the module's defaults and takes its installed files with it.
 *
 * Naming the keys, rather than refreshing the file, is what keeps this from becoming a fourth
 * ownership shape. The file stays the user's. The kit reconciles the listed keys and never
 * reads or writes a byte of the rest. See {@link ./merge-config-keys.ts}.
 */
export interface SeedAction extends ActionBase {
  kind: 'seed';
  dest: string;
  content: string;
  reason: string;
  /** JSON top-level keys the kit reconciles when the file already exists. */
  managedKeys?: string[];
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

/**
 * A file whose BODY the kit owns and whose FRONTMATTER you own. The mirror image of
 * {@link RegionAction}. There the kit owns a marked span inside a file that is yours.
 * Here it owns everything below the closing `---`, and the frontmatter above it is yours
 * to configure.
 *
 * Rule files are the case this exists for. The kit's own advice tells you to trim a rule's
 * `paths:` globs to the suffixes your repo uses, and a whole-file hash would then freeze
 * the rule BODY at whatever shipped the day you trimmed it. The manifest records the body
 * hash and the shipped frontmatter hash separately, so `update` splices a fresh body under
 * whatever frontmatter is on disk.
 *
 * On a fresh install there is no host file to splice into, so the payload file is written
 * whole, frontmatter included.
 */
export interface BodyAction extends ActionBase {
  kind: 'body';
  /** Absolute path under payload/. */
  src: string;
  /** Repo-relative destination. */
  dest: string;
  reason: string;
  /**
   * Text appended below the payload file's own body, composed by the module from what the
   * user selected. The kit owns it exactly as it owns the rest of the body, so the recorded
   * body hash covers both and `update` refreshes the pair together.
   *
   * This is what lets a rule point at an OPTIONAL file. A link that ships in the payload
   * dangles wherever that option was not chosen, so the pointer has to be as conditional as
   * the file it points at. Keep it to routing. A rule whose substance depends on this is a
   * rule that should have been two.
   */
  appendBody?: string;
}

/** A fragment folded into .claude/settings.json. */
export interface MergeSettingsAction extends ActionBase {
  kind: 'merge-settings';
  fragment: SettingsFragment;
}

/** A line for the post-install next-steps checklist. */
export interface AdviseAction extends ActionBase {
  kind: 'advise';
  text: string;
}

/**
 * What a module declares should exist. Modules never touch the filesystem. They
 * return these and the plan engine turns them into Effects.
 */
export type Action =
  | CopyAction
  | WriteAction
  | SeedAction
  | RegionAction
  | BodyAction
  | MergeSettingsAction
  | AdviseAction;

/** The actions that name a destination path. Everything except advise/settings. */
export type FileAction =
  CopyAction | WriteAction | SeedAction | RegionAction | BodyAction;
