import type { Ctx } from '../../detect.js';
import type { CheckResult, Finding } from '@houserules/api';

const MIN_NODE_MAJOR = 20;

/** The host preconditions houserules cannot run without. */
export function checkEnvironment(ctx: Ctx): CheckResult {
  const findings: Finding[] = [];
  const major = process.versions.node.split('.').map(Number)[0];
  if (major === undefined || major < MIN_NODE_MAJOR)
    findings.push({
      level: 'ERROR',
      msg: `node ${process.versions.node} < ${MIN_NODE_MAJOR}`,
    });
  if (!ctx.git.isRepo)
    findings.push({ level: 'ERROR', msg: 'not a git work tree' });
  return { findings, readouts: [] };
}
