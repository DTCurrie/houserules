import { sep } from 'node:path';

import type { Ctx } from '../../detect.js';
import type { CheckResult, Finding } from '@houserules/api';

/**
 * Flags the subdirectory-session hazard: Claude Code loads project `.claude/settings.json`
 * from the session cwd only, so a session launched from a subdirectory of the install root
 * runs with every installed hook, guard-bash included, silently inactive. Silent when there
 * is no git toplevel to compare against, or when the install root IS the toplevel.
 */
export function checkLaunchRoot(root: string, ctx: Ctx): CheckResult {
  const findings: Finding[] = [];

  const top = ctx.git.top;
  if (top && root !== top && root.startsWith(`${top}${sep}`)) {
    findings.push({
      level: 'WARN',
      msg: `install root is nested inside the git toplevel (${top}) — a session launched outside ${root} runs without houserules hooks, so Claude Code sessions must start at the install root.`,
    });
  }

  return { findings, readouts: [] };
}
