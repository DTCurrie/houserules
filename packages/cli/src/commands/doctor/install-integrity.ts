import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ledgerDirFor } from '../../core/ledger-dir.js';
import { MANIFEST_PATH } from '../../core/manifest.js';
import {
  trackedLedgerSurfaces,
  trackedScriptFiles,
  trackedTemplateFiles,
} from '../../detect.js';
import type { Ctx } from '../../detect.js';
import { payloadPath } from '../../paths.js';
import { MODULES } from '../../plan.js';
import type { Registry } from '../../plugin-registry.js';
import type { CheckResult, Finding } from './finding.js';
import { allHookCommands } from './settings-wiring.js';

/** Every `.mjs` script name shipped across a set of built payload directories. */
function shippedScripts(dirs: string[]): Set<string> {
  const scripts = new Set<string>();
  for (const dir of dirs) {
    try {
      for (const f of readdirSync(dir)) if (f.endsWith('.mjs')) scripts.add(f);
    } catch {
      /* payload directory unreadable. Skip it for the retired-script check. */
    }
  }
  return scripts;
}

/**
 * Whether what the manifest claims still matches what this kit ships: the receipt
 * exists, its version is current, nothing generated got committed, and no retired
 * module or hook script is left behind.
 *
 * @param registry Built-ins plus every configured plugin's modules, as `checkConfigValidity`
 * resolved it. Null only when a plugin failed to resolve, which that check already reported,
 * and the retired-module scan then falls back to the built-ins.
 */
export function checkInstallIntegrity(
  root: string,
  ctx: Ctx,
  kitVersion: string,
  registry: Registry | null,
): CheckResult {
  const findings: Finding[] = [];
  const manifest = ctx.claude.manifest;

  if (!manifest) {
    findings.push({
      level: 'ERROR',
      msg: `no ${MANIFEST_PATH} — kit not installed here (run: npx agent-kit init)`,
    });
    return { findings, readouts: [] };
  }

  if (manifest.kitVersion !== kitVersion) {
    findings.push({
      level: 'WARN',
      msg: `installed kit v${manifest.kitVersion}, this CLI is v${kitVersion} — run: npx agent-kit update`,
    });
  }
  // Reference templates that got committed before the kit ignored them. File integrity
  // itself is the drift engine's job, further down.
  const strayTemplates = ctx.git.isRepo ? trackedTemplateFiles(root) : [];
  if (strayTemplates.length) {
    findings.push({
      level: 'WARN',
      msg: `${strayTemplates.length} reference template(s) under .claude/kit-templates/ are committed (reference-only). Untrack, keeping them on disk: npx agent-kit update — or: git rm --cached -r .claude/kit-templates && git add .claude/kit-templates/.gitignore`,
    });
  }
  // Same story for .claude/scripts/, which is build output.
  const commitScripts = ctx.claude.kitConfig?.scripts?.commit === true;
  const strayScripts =
    ctx.git.isRepo && !commitScripts ? trackedScriptFiles(root) : [];
  if (strayScripts.length) {
    findings.push({
      level: 'WARN',
      msg: `${strayScripts.length} script(s) under .claude/scripts/ are committed (build output). Untrack, keeping them on disk: npx agent-kit update — or: git rm --cached -r .claude/scripts && git add .claude/scripts/.gitignore`,
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
      msg: `${strayLedgers.length} rendered ledger file(s) are committed (generated from the .jsonl beside them). Untrack, keeping them on disk: npx agent-kit update — or: git rm --cached ${strayLedgers.join(' ')}`,
    });
  }

  // Modules and hooks the manifest records but the current kit no longer defines. The
  // kit is otherwise add-and-update-only, so without this an orphan stays invisible.
  // Resolved against the registry, which includes every module a configured plugin
  // contributes, not just the built-ins.
  const knownModuleIds = new Set(
    registry ? registry.modules.map((m) => m.id) : MODULES.map((m) => m.id),
  );
  for (const id of manifest.modules ?? []) {
    if (!knownModuleIds.has(id))
      findings.push({
        level: 'WARN',
        msg: `manifest lists module "${id}" which this kit no longer defines — npx agent-kit update prunes its retired files/hooks`,
      });
  }
  // A kit-owned OR kit-signed hook script this kit no longer ships is retired. Scripts
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
      msg: `retired kit hook script ${base} is no longer shipped by this kit${wired ? ' but is still wired (a dead node process on every trigger)' : ''} — prune it: npx agent-kit update`,
    });
  }

  return { findings, readouts: [] };
}
