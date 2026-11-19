import type { Ctx } from '../../detect.js';
import { requirementsOf } from '../../module-requires.js';
import { resolveModuleOptions } from '../../module-options.js';
import { hasModule, type Registry } from '../../plugin-registry.js';
import type { CheckResult, Finding, ModuleRequirement } from '@houserules/api';

/**
 * Reports each installed module whose requirement is not installed. A WARN, not an ERROR,
 * because `update` repairs the gap and every install that predates requirements would
 * otherwise exit 1 on the day it upgrades.
 */
export function checkModuleRequirements(
  ctx: Ctx,
  registry: Registry | null,
): CheckResult {
  const findings: Finding[] = [];
  const installedIds = ctx.claude.manifest?.modules;
  if (!registry || !installedIds) return { findings, readouts: [] };

  const options = resolveModuleOptions(
    registry,
    installedIds,
    ctx.claude.houseConfig?.moduleOptions,
  );
  for (const id of installedIds) {
    const module = registry.get(id);
    if (!module) continue;
    for (const requirement of requirementsOf(module, options[id] ?? [])) {
      if (hasModule(installedIds, requirement.id)) continue;
      findings.push({
        level: 'WARN',
        msg: unmetMessage(id, requirement, registry),
      });
    }
  }
  return { findings, readouts: [] };
}

function unmetMessage(
  requirer: string,
  requirement: ModuleRequirement,
  registry: Registry,
): string {
  const prefix = `"${requirer}" requires "${requirement.id}", which`;
  if (registry.modules.some((module) => module.def.id === requirement.id))
    return `${prefix} is not installed. Run \`npx houserules update\` to install it.`;
  if (!requirement.package) return `${prefix} no installed plugin supplies.`;
  return `${prefix} no installed plugin supplies. Install ${requirement.package} and add it to the "plugins" array in .claude/houserules.config.json.`;
}
