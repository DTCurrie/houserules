import type { RegionSpec } from './core/regions.js';
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

/** User-owned: written only when absent, never refreshed or overwritten. */
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
  | MergeSettingsAction
  | AdviseAction;

/** The actions that name a destination path. Everything except advise/settings. */
export type FileAction = CopyAction | WriteAction | SeedAction | RegionAction;
