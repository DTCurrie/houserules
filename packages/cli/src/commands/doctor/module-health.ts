import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Ctx } from '../../detect.js';
import type { Registry } from '../../plugin-registry.js';
import { verifyDefaultsFor } from '../../render.js';
import type { CheckResult, Finding } from '@houserules/api';

/**
 * Whether each installed module has what it needs to actually do its job.
 *
 * Iterates the REGISTRY, not the built-in `MODULES` array. `check` is public plugin API, so a
 * plugin that ships one has to be asked for it. Reading the built-ins alone silently ignored
 * every plugin's health check while the type surface advertised it.
 */
export function checkModuleHealth(
  root: string,
  ctx: Ctx,
  registry: Registry | null,
): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];
  const manifest = ctx.claude.manifest;
  const config = ctx.claude.houseConfig;
  const installed = (id: string) => Boolean(manifest?.modules?.includes(id));

  // Null on a repo with no houserules installed, which is also a repo with no module to check.
  for (const module of registry?.modules ?? []) {
    if (!installed(module.id) || !module.def.check) continue;
    // A plugin's check is third-party code running inside doctor. One that throws must not
    // take the whole report down, so its failure is reported as a finding about that module.
    try {
      const result = module.def.check(ctx);
      findings.push(...result.findings);
      readouts.push(...result.readouts);
    } catch (error) {
      findings.push({
        level: 'WARN',
        msg: `module ${module.id} threw from its health check: ${(error as Error).message}`,
      });
    }
  }

  for (const agentFile of ctx.claude.agents) {
    try {
      const text = readFileSync(
        join(root, '.claude', 'agents', agentFile),
        'utf8',
      );
      if (/^description:.*DRAFT/m.test(text))
        findings.push({
          level: 'WARN',
          msg: `agent ${agentFile} is still a DRAFT — fill in its authoritative source`,
        });
    } catch {
      /* unreadable agent file. Not the doctor's problem. */
    }
  }

  if (installed('verify-changed') && config && !config.verify) {
    findings.push({
      level: 'WARN',
      msg:
        'verify-changed module installed but no `verify` block in houserules.config.json — add one by hand ' +
        '(`update` will NOT: houserules.config.json is user-owned and never rewritten). For this repo: ' +
        `"verify": ${JSON.stringify(verifyDefaultsFor(ctx.packageManager, ctx.isMonorepo))}`,
    });
  }

  return { findings, readouts };
}
