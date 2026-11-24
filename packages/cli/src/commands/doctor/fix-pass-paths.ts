import type { RunnerBlock } from '@houserules/payload/config';
import { resolveTargetCommands } from '@houserules/payload/config';
import type { CheckResult, Finding } from '@houserules/api';

import type { Ctx } from '../../detect.js';
import { installedModuleIds } from '../../installed-modules.js';
import { passPathsDefault } from '../../path-taking-scripts.js';
import { hasModule } from '@houserules/api';

const PATH_TAKING_FORM = '`eslint --fix` and `prettier --write`';

function quoted(scripts: readonly string[]): string {
  return scripts.map((script) => `"${script}"`).join(', ');
}

/**
 * Reports `fix.passPaths` against the fix scripts the Stop hook would run. A Stop with the key
 * off fixes nothing. The key on with a script that targets `.` fixes the whole tree. Both
 * judgments come from `passPathsDefault`, so `init` and `doctor` share one definition of a
 * script that takes paths. A WARN, not an ERROR, since a Stop that fixes nothing is not a
 * broken install.
 */
export function checkFixPassPaths(ctx: Ctx): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];
  const config = ctx.claude.houseConfig;
  const installed = installedModuleIds(config, ctx.claude.manifest) ?? [];
  if (!config || !hasModule(installed, 'lint-fix'))
    return { findings, readouts };

  const fix: RunnerBlock = config.fix ?? {};
  const targets = (config.targets ?? [])
    .filter(
      (target) =>
        target.packageName !== undefined && target.pathPrefix !== undefined,
    )
    .map((target) => ({
      pathPrefix: target.pathPrefix,
      fixCommands: resolveTargetCommands(target.fixCommands, fix.commands),
    }));
  const { isOn, rejectedScripts } = passPathsDefault(ctx, targets, fix);
  const keyIsOn = fix.passPaths === true;

  if (!keyIsOn && isOn) {
    findings.push({
      level: 'WARN',
      msg: 'A Stop fixes nothing, though every fix script takes paths. Set `passPaths` to `true` in the `fix` block of .claude/houserules.config.json to turn fix.passPaths on.',
    });
  } else if (keyIsOn && rejectedScripts.length > 0) {
    findings.push({
      level: 'WARN',
      msg: `fix.passPaths is on, but these fix scripts do not take paths: ${quoted(rejectedScripts)}. A Stop appends the turn's changed paths to each, so a script that targets \`.\` fixes the whole tree. Name scripts that take paths, such as \`eslint --fix\` and \`prettier --write\`, in \`fixCommands\`.`,
    });
  } else if (!keyIsOn && rejectedScripts.length > 0) {
    readouts.push(
      `A Stop fixes nothing while fix.passPaths is off, and these fix scripts do not take paths: ${quoted(rejectedScripts)}. Scripts that do, such as ${PATH_TAKING_FORM}, let you turn it on.`,
    );
  }
  return { findings, readouts };
}
