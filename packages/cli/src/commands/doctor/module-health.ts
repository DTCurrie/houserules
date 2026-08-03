import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MODULES } from '../../plan.js';
import type { Ctx } from '../../detect.js';
import { verifyDefaultsFor } from '../../render.js';
import type { CheckResult, Finding } from './finding.js';

/** Whether each installed module has what it needs to actually do its job. */
export function checkModuleHealth(root: string, ctx: Ctx): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];
  const manifest = ctx.claude.manifest;
  const config = ctx.claude.kitConfig;
  const installed = (id: string) => Boolean(manifest?.modules?.includes(id));

  for (const module of MODULES) {
    if (installed(module.id) && module.check) {
      const result = module.check(ctx);
      findings.push(...result.findings);
      readouts.push(...result.readouts);
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
        'verify-changed module installed but no `verify` block in kit.config.json — add one by hand ' +
        '(`update` will NOT: kit.config.json is user-owned and never rewritten). For this repo: ' +
        `"verify": ${JSON.stringify(verifyDefaultsFor(ctx.packageManager, ctx.isMonorepo))}`,
    });
  }

  return { findings, readouts };
}
