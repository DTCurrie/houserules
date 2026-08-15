import type {
  PackageJson,
  WorkspacePackage,
} from '@houserules/payload/workspaces';

import type { HouseConfig, HouseConfigTarget } from './config.js';
import type { HouseManifest } from './manifest.js';
import type { Settings } from './merge-settings.js';

/** How the package manager was identified. Shown in the profile card. */
export type PackageManagerSource = 'packageManager' | 'lockfile' | 'default';

export interface PackageManagerInfo {
  name: string;
  version?: string;
  source: PackageManagerSource;
}

/**
 * A unit of the repo houserules tracks: a workspace package, or the repo itself for a
 * single-package repo. Detection proposes these. `houserules.config.json` is the contract
 * once the user has edited it.
 *
 * It is deliberately the SAME type as a config target rather than a near-duplicate.
 * `update`/`modules` prefer `houseConfig.targets` and fall back to detection's, so the
 * two are used interchangeably. Declaring them separately only invited them to
 * drift on optionality. Per-field documentation lives on the zod schema's
 * `.describe()` calls in `config.ts`.
 */
export type Target = HouseConfigTarget;

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
  manifest: HouseManifest | null;
  houseConfig: HouseConfig | null;
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
  /** Prettier can run here, so houserules' files need protecting from it. */
  prettier: boolean;
  changesets: ChangesetsState;
  pnpmCatalogModeStrict: boolean;
  claude: ClaudeState;
}
