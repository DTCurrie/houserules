/**
 * Who is allowed to write to the project board.
 *
 * The board belongs to the maintainer. A contributor whose agent logs freely must not reach it,
 * and nothing they can edit and open a pull request against may change that. Two independent
 * conditions, and a push needs both:
 *
 * 1. A local enable token, `.claude/ledgers/.projects.json`, written only by an explicit
 *    `bootstrap` run. It is gitignored, so it never arrives with a clone.
 * 2. `maintain` or `admin` on the repository. Write access alone is not enough, because that is
 *    exactly the population at risk.
 *
 * Committed config moves in one direction only. `projects.autoSync: false` forbids sync
 * repo-wide. `true` merely permits it, and permits nothing on its own. **Granting requires both
 * conditions. Denying requires either.**
 *
 * The decision is split from the I/O on purpose. {@link evaluateGate} is pure, so the truth
 * table is covered without mocking a process, and {@link readGateInputs} is the only part that
 * touches disk or network.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { RepoPermissions } from './gh.mjs';
import { ghPermissions, ghRepo } from './gh.mjs';

/** Everything the decision depends on, gathered so the decision itself stays pure. */
export interface GateInputs {
  /** Whether `.claude/ledgers/.projects.json` exists locally. */
  hasEnableToken: boolean;
  /** `projects.autoSync` from kit.config.json. Undefined when the key is absent. */
  autoSync: boolean | undefined;
  /** Null when the permission call failed or was never made. */
  permissions: RepoPermissions | null;
}

/**
 * Why a gate decision came out the way it did.
 *
 * A discriminated reason rather than a bare boolean, because every caller prints different
 * remediation. `bootstrap` tells a contributor their ledger still works, `push` says nothing at
 * all, and the `SessionEnd` hook returns without writing a log line.
 */
export type GateVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'no-token'; message: string }
  | { allowed: false; reason: 'auto-sync-disabled'; message: string }
  | { allowed: false; reason: 'insufficient-permission'; message: string }
  | { allowed: false; reason: 'permission-unknown'; message: string };

const NO_TOKEN_MESSAGE =
  'No local sync token. Run the `bootstrap` command once as a maintainer to enable it. Your ' +
  'local ledger keeps recording either way.';

const AUTO_SYNC_DISABLED_MESSAGE =
  'projects.autoSync is set to false in kit.config.json. A maintainer turned sync off for this ' +
  'repo. Your local ledger keeps recording either way.';

const PERMISSION_UNKNOWN_MESSAGE =
  'Could not read your permissions on this repository, so sync stayed off rather than guess. ' +
  'Your local ledger keeps recording either way.';

const INSUFFICIENT_PERMISSION_MESSAGE =
  'Your local ledger still works. Syncing to the project board needs maintain or admin access ' +
  'on this repository, which this account does not have. Open an issue on the issues tab ' +
  'instead, or ask a maintainer to run /backlog-adopt on it once it lands.';

const READ_INSUFFICIENT_PERMISSION_MESSAGE =
  'Could not read the project board. This account has no read access on this repository, so ' +
  'there is nothing to compare the local ledger against.';

/**
 * The WRITE gate decision, from data alone. See {@link evaluateReadGate} for the weaker gate
 * that covers operations that only read the board.
 *
 * Order matters. The cheapest and most common denial comes first, and `no-token` outranks
 * everything because it is the clone-without-bootstrap case: a contributor should never see a
 * message about permissions they were never going to be asked for.
 */
export function evaluateGate(inputs: GateInputs): GateVerdict {
  if (!inputs.hasEnableToken) {
    return { allowed: false, reason: 'no-token', message: NO_TOKEN_MESSAGE };
  }
  if (inputs.autoSync === false) {
    return {
      allowed: false,
      reason: 'auto-sync-disabled',
      message: AUTO_SYNC_DISABLED_MESSAGE,
    };
  }
  if (inputs.permissions === null) {
    return {
      allowed: false,
      reason: 'permission-unknown',
      message: PERMISSION_UNKNOWN_MESSAGE,
    };
  }
  if (!inputs.permissions.maintain && !inputs.permissions.admin) {
    return {
      allowed: false,
      reason: 'insufficient-permission',
      message: INSUFFICIENT_PERMISSION_MESSAGE,
    };
  }
  return { allowed: true };
}

/**
 * The READ gate decision, for operations that only read the project board, such as `pull`.
 * Weaker than {@link evaluateGate} on purpose: it does not require the local enable token,
 * since a contributor who cannot push should still be able to hold a local index.
 */
export function evaluateReadGate(inputs: GateInputs): GateVerdict {
  if (inputs.autoSync === false) {
    return {
      allowed: false,
      reason: 'auto-sync-disabled',
      message: AUTO_SYNC_DISABLED_MESSAGE,
    };
  }
  if (inputs.permissions === null) {
    return {
      allowed: false,
      reason: 'permission-unknown',
      message: PERMISSION_UNKNOWN_MESSAGE,
    };
  }
  const canRead =
    inputs.permissions.pull ||
    inputs.permissions.push ||
    inputs.permissions.maintain ||
    inputs.permissions.admin;
  if (!canRead) {
    return {
      allowed: false,
      reason: 'insufficient-permission',
      message: READ_INSUFFICIENT_PERMISSION_MESSAGE,
    };
  }
  return { allowed: true };
}

/**
 * Gathers {@link GateInputs} from disk and from GitHub.
 *
 * The permission call is skipped when a local condition already denies, so the common case
 * costs no network round trip.
 *
 * Takes the resolved ledger directory and `autoSync` rather than reading `kit.config.json`
 * itself. That reader and the directory resolver both live in the shared `@agent-kit/payload`
 * package, reached here by package-name import: `agent-kit-payload` rewrites the specifier at
 * build to the relative path the flattened `.claude/scripts/lib/` layout needs, so this file
 * can import them statically rather than reading config directly.
 */
export function readGateInputs(
  ledgerDirectory: string,
  autoSync: boolean | undefined,
  { requireToken = true }: { requireToken?: boolean } = {},
): GateInputs {
  const tokenPath = resolve(ledgerDirectory, ENABLE_TOKEN_BASENAME);
  const hasEnableToken = existsSync(tokenPath);

  // The write gate skips the permission call when there is no token, because the token is
  // already disqualifying and the round trip would be wasted. A read gate does not care about
  // the token at all, so skipping there would report `permission-unknown` for exactly the
  // contributor this whole path exists to serve. Hence `requireToken: false` for `pull`.
  const tokenBlocks = requireToken && !hasEnableToken;
  if (tokenBlocks || autoSync === false) {
    return { hasEnableToken, autoSync, permissions: null };
  }

  const repo = ghRepo();
  if (!repo.ok) return { hasEnableToken, autoSync, permissions: null };

  const permissionsResult = ghPermissions(repo.value.owner, repo.value.repo);
  const permissions = permissionsResult.ok ? permissionsResult.value : null;

  return { hasEnableToken, autoSync, permissions };
}

/** Where the enable token lives, relative to the ledger directory. */
export const ENABLE_TOKEN_BASENAME = '.projects.json';
