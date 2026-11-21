import type { CheckResult, Finding } from '@houserules/api';
import type { Flags } from '../../cli-contract.js';
import {
  applyPrepareScript,
  PACKAGE_JSON,
  planPrepareScript,
  PREPARE_COMMAND,
} from '../../prepare-script.js';

/**
 * Reports a root `package.json` that depends on `@houserules/cli` but whose `prepare` script
 * does not run `houserules update --sync`. Under `--fix` it writes the script, then plans again
 * so the report reflects the repaired file.
 */
export function checkPrepareScript(root: string, flags: Flags): CheckResult {
  const findings: Finding[] = [];
  let plan = planPrepareScript(root);

  if (flags.fix && applyPrepareScript(root, plan)) {
    plan = planPrepareScript(root);
  }

  if (plan.kind === 'add' || plan.kind === 'append') {
    findings.push({
      level: 'WARN',
      msg: `${PACKAGE_JSON} has no \`prepare\` script running \`${PREPARE_COMMAND}\`, so a fresh clone has no payload until it is run by hand. \`doctor --fix\` adds it.`,
    });
  } else if (plan.kind === 'unparseable') {
    findings.push({
      level: 'WARN',
      msg: `${PACKAGE_JSON} does not parse (${plan.message}), so the \`prepare\` script could not be checked. Fix the file by hand.`,
    });
  }

  return { findings, readouts: [] };
}
