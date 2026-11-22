import { installedModuleIds } from '../../installed-modules.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ledgerDirFor } from '../../core/ledger-dir.js';
import { MANIFEST_PATH } from '@houserules/api/internal';
import {
  trackedAmong,
  trackedLedgerLogs,
  trackedLedgerSurfaces,
  trackedScriptFiles,
  trackedTemplateFiles,
} from '../../detect.js';
import type { Ctx } from '../../detect.js';
import { PAYLOAD_GITIGNORE_REGION } from '../../modules/payload-gitignore.js';
import { payloadPath } from '../../paths.js';
import { MODULES } from '../../plan.js';
import type { Registry } from '../../plugin-registry.js';
import type { CheckResult, Finding } from '@houserules/api';
import { compareSemver, parseSemver } from './semver.js';
import { allHookCommands } from './settings-wiring.js';

/** Every `.mjs` script name shipped across a set of built payload directories. */
function shippedScripts(dirs: string[]): Set<string> {
  const scripts = new Set<string>();
  for (const dir of dirs) {
    try {
      for (const f of readdirSync(dir)) if (f.endsWith('.mjs')) scripts.add(f);
    } catch (error) {
      // ENOENT (payload never built) is expected and silent. Anything else, most often a
      // permission problem, means the retired-script scan below cannot tell "genuinely
      // retired" from "could not check", so it is worth telling the user.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(
          `houserules: could not list ${dir} (${(error as Error).message}). Its scripts may be misreported as retired.`,
        );
      }
    }
  }
  return scripts;
}

/** How doctor learns the published `latest`, injectable so tests never reach the network. */
export interface PublishedVersionLookup {
  /** The environment the skip conditions read. */
  env: NodeJS.ProcessEnv;
  /** The registry's `latest` for `@houserules/cli`, or null when it cannot be known. */
  latestVersion: () => string | null;
}

const CLI_PACKAGE = '@houserules/cli';
const REGISTRY_TIMEOUT_MS = 3000;

/**
 * Asks npm for the `latest` dist-tag, so the user's registry and proxy config apply. Null on
 * every failure (offline, npm absent, non-zero exit, timeout, unparseable output), never a throw.
 */
function npmLatestVersion(): string | null {
  try {
    const out = execFileSync('npm', ['view', CLI_PACKAGE, 'dist-tags.latest'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: REGISTRY_TIMEOUT_MS,
      // Windows resolves npm only as npm.cmd, which Node spawns only through a shell.
      // Every argument here is a constant, so the shell has nothing to interpolate.
      shell: process.platform === 'win32',
    }).trim();
    return parseSemver(out) ? out : null;
  } catch {
    return null;
  }
}

const DEFAULT_LOOKUP: PublishedVersionLookup = {
  env: process.env,
  latestVersion: npmLatestVersion,
};

/**
 * update-notifier's skip conditions: `NO_UPDATE_NOTIFIER` set to anything, `NODE_ENV=test`,
 * or a CI environment as `is-in-ci` detects one (`CI`, `CONTINUOUS_INTEGRATION`, or any
 * `CI_*` variable, unless `CI` is `0` or `false`).
 */
function isUpdateCheckSkipped(env: NodeJS.ProcessEnv): boolean {
  if ('NO_UPDATE_NOTIFIER' in env) return true;
  if (env.NODE_ENV === 'test') return true;
  if (env.CI === '0' || env.CI === 'false') return false;
  return (
    'CI' in env ||
    'CONTINUOUS_INTEGRATION' in env ||
    Object.keys(env).some((key) => key.startsWith('CI_'))
  );
}

/** The command that moves the repo's devDependency CLI to `latest`, in the repo's package manager. */
function cliUpgradeCommand(ctx: Ctx): string {
  const manager = ctx.packageManager?.name ?? 'npm';
  if (manager === 'npm') return `npm install -D ${CLI_PACKAGE}@latest`;
  const workspaceRoot = manager === 'pnpm' && ctx.isMonorepo ? ' -w' : '';
  return `${manager} add -D${workspaceRoot} ${CLI_PACKAGE}@latest`;
}

/**
 * A readout when the install AND the running CLI are both behind the published `latest`. The
 * running-CLI comparison cannot see this, since a repo's own devDependency CLI is as old as its
 * install. When the running CLI is already at `latest`, that comparison's `update` advice is
 * the whole fix, so this stays silent. Also silent when skipped or when the lookup fails.
 */
function publishedVersionReadout(
  ctx: Ctx,
  installed: string,
  runningCli: string,
  lookup: PublishedVersionLookup,
): string[] {
  const installedSemver = parseSemver(installed);
  const runningSemver = parseSemver(runningCli);
  if (!installedSemver || !runningSemver || isUpdateCheckSkipped(lookup.env))
    return [];
  const latest = lookup.latestVersion();
  const latestSemver = latest ? parseSemver(latest) : null;
  if (!latestSemver) return [];
  if (compareSemver(installedSemver, latestSemver) >= 0) return [];
  if (compareSemver(runningSemver, latestSemver) >= 0) return [];
  return [
    `installed houserules v${installed}, latest published is v${latest}. Update the CLI, then the install: ${cliUpgradeCommand(ctx)} && npx houserules update`,
  ];
}

/** Git tracks the manifest while the payload ignore block lists it: committed before the block existed. */
function isManifestTracked(root: string, ctx: Ctx): boolean {
  if (!ctx.git.isRepo) return false;
  if (ctx.claude.houseConfig?.payload?.commit === true) return false;
  let gitignore: string;
  try {
    gitignore = readFileSync(join(root, '.claude', '.gitignore'), 'utf8');
  } catch {
    return false;
  }
  if (!gitignore.includes(PAYLOAD_GITIGNORE_REGION.start)) return false;
  return trackedAmong(root, [MANIFEST_PATH]).length > 0;
}

/**
 * Whether what the manifest claims still matches what houserules ships: the receipt
 * exists, its version is current, nothing generated got committed, and no retired
 * module or hook script is left behind.
 *
 * @param registry Built-ins plus every configured plugin's modules, as `checkConfigValidity`
 * resolved it. Null only when a plugin failed to resolve, which that check already reported,
 * and the retired-module scan then falls back to the built-ins.
 * @param lookup Where the published `latest` comes from. Defaults to `npm view`, gated by
 * update-notifier's skip conditions on `process.env`.
 */
export function checkInstallIntegrity(
  root: string,
  ctx: Ctx,
  kitVersion: string,
  registry: Registry | null,
  lookup: PublishedVersionLookup = DEFAULT_LOOKUP,
): CheckResult {
  const findings: Finding[] = [];
  const manifest = ctx.claude.manifest;

  if (!manifest) {
    findings.push({
      level: 'ERROR',
      msg: `no ${MANIFEST_PATH} — houserules not installed here (run: npx houserules init)`,
    });
    return { findings, readouts: [] };
  }

  if (manifest.kitVersion !== kitVersion) {
    findings.push({
      level: 'WARN',
      msg: `installed houserules v${manifest.kitVersion}, this CLI is v${kitVersion}. Run: npx houserules update`,
    });
  }
  if (isManifestTracked(root, ctx)) {
    findings.push({
      id: 'manifest-tracked',
      level: 'WARN',
      msg: `${MANIFEST_PATH} is committed, but it is local state now, listed in .claude/.gitignore. Untrack it, keeping it on disk: npx houserules update`,
    });
  }
  // Reference templates that got committed before houserules ignored them. File integrity
  // itself is the drift engine's job, further down.
  const strayTemplates = ctx.git.isRepo ? trackedTemplateFiles(root) : [];
  if (strayTemplates.length) {
    findings.push({
      level: 'WARN',
      msg: `${strayTemplates.length} reference template(s) under .claude/templates/ are committed (reference-only). Untrack, keeping them on disk: npx houserules update — or: git rm --cached -r .claude/templates && git add .claude/templates/.gitignore`,
    });
  }
  // Same story for .claude/scripts/, which is build output.
  const commitScripts = ctx.claude.houseConfig?.scripts?.commit === true;
  const strayScripts =
    ctx.git.isRepo && !commitScripts ? trackedScriptFiles(root) : [];
  if (strayScripts.length) {
    findings.push({
      level: 'WARN',
      msg: `${strayScripts.length} script(s) under .claude/scripts/ are committed (build output). Untrack, keeping them on disk: npx houserules update — or: git rm --cached -r .claude/scripts && git add .claude/scripts/.gitignore`,
    });
  }

  // And for the rendered ledgers, which are a view of the .jsonl beside them. The .jsonl
  // stays committed: it is the record, and the markdown is rebuilt from it by `render`.
  const ledgerDir = ledgerDirFor(ctx);
  const strayLedgers =
    ctx.git.isRepo && ledgerDir ? trackedLedgerSurfaces(root, ledgerDir) : [];
  if (strayLedgers.length) {
    findings.push({
      level: 'WARN',
      msg: `${strayLedgers.length} rendered ledger file(s) are committed (generated from the .jsonl beside them). Untrack, keeping them on disk: npx houserules update — or: git rm --cached ${strayLedgers.join(' ')}`,
    });
  }

  // The .jsonl itself used to be the durable record. A GitHub Project now holds that role,
  // and the local file is a gitignored push queue, so a committed one predates the move.
  const strayLedgerLogs =
    ctx.git.isRepo && ledgerDir ? trackedLedgerLogs(root, ledgerDir) : [];
  if (strayLedgerLogs.length) {
    findings.push({
      level: 'WARN',
      msg: `${strayLedgerLogs.length} ledger log(s) are committed. The GitHub Project is the durable record now, once \`projects-sync.mjs push\` has run, and the file stays on disk as a push queue. Untrack it: npx houserules update — or: git rm --cached ${strayLedgerLogs.join(' ')}`,
    });
  }

  // Modules and hooks the manifest records but the current houserules no longer defines. The
  // houserules is otherwise add-and-update-only, so without this an orphan stays invisible.
  // Resolved against the registry, which includes every module a configured plugin
  // contributes, not just the built-ins.
  const knownModuleIds = new Set(
    registry ? registry.modules.map((m) => m.id) : MODULES.map((m) => m.id),
  );
  for (const id of installedModuleIds(ctx.claude.houseConfig, manifest) ?? []) {
    if (!knownModuleIds.has(id))
      findings.push({
        level: 'WARN',
        msg: `manifest lists module "${id}" which houserules no longer defines — npx houserules update prunes its retired files/hooks`,
      });
  }
  // A kit-owned OR kit-signed hook script houserules no longer ships is retired. Scripts
  // ship from the CLI's own payload plus every resolved plugin's payload.
  const scriptDirs = [
    payloadPath('scripts'),
    ...(registry?.plugins.map((p) => join(p.dir, 'payload-dist', 'scripts')) ??
      []),
  ];
  const currentScripts = shippedScripts(scriptDirs);
  const suspects = new Set<string>();
  for (const p of Object.keys(manifest.files ?? {}))
    if (/^\.claude\/scripts\/[^/]+\.mjs$/.test(p))
      suspects.add(p.split('/').pop()!);
  for (const h of manifest.settings?.hooks ?? [])
    if (h.script) suspects.add(h.script);
  const wiredCommands = ctx.claude.settings
    ? allHookCommands(ctx.claude.settings)
    : [];
  for (const base of suspects) {
    if (currentScripts.has(base)) continue; // still shipped — fine
    const wired = wiredCommands.some((c) => c.includes(base));
    findings.push({
      level: 'WARN',
      msg: `retired houserules hook script ${base} is no longer shipped by houserules${wired ? ' but is still wired (a dead node process on every trigger)' : ''} — prune it: npx houserules update`,
    });
  }

  return {
    findings,
    readouts: publishedVersionReadout(
      ctx,
      manifest.kitVersion,
      kitVersion,
      lookup,
    ),
  };
}
