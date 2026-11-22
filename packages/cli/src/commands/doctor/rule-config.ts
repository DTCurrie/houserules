import type { Action, CheckResult, Finding } from '@houserules/api';
import type { Ctx } from '../../detect.js';
import { installedModuleIds } from '../../installed-modules.js';
import { resolveModuleOptions } from '../../module-options.js';
import { buildPlan } from '../../plan.js';
import type { Registry } from '../../plugin-registry.js';

const RULE_DEST = /^\.claude\/rules\/([^/]+)\.md$/;

/**
 * Reports a config `rules` key that names no installed rule, since its `paths` would then
 * change nothing and the typo goes unnoticed. The installed set comes from the plan the
 * config's modules produce, not from disk, so a fresh clone with no rule files yet is not
 * flagged. A WARN, like an unmet module requirement: `update` and the install still work.
 */
export function checkRuleConfig(
  ctx: Ctx,
  registry: Registry | null,
): CheckResult {
  const findings: Finding[] = [];
  const configured = Object.keys(ctx.claude.houseConfig?.rules ?? {});
  if (!registry || configured.length === 0) return { findings, readouts: [] };

  const moduleIds = installedModuleIds(
    ctx.claude.houseConfig,
    ctx.claude.manifest,
  ) ?? ['core'];
  const actions = planFor(ctx, moduleIds, registry);
  if (!actions) return { findings, readouts: [] };

  const known = new Set(
    actions.flatMap((action) => {
      const id = 'dest' in action ? RULE_DEST.exec(action.dest)?.[1] : null;
      return id ? [id] : [];
    }),
  );
  for (const id of configured) {
    if (known.has(id)) continue;
    findings.push({
      level: 'WARN',
      msg: `rules."${id}" in .claude/houserules.config.json names no installed rule, so its settings change nothing. Check the id against the file names under .claude/rules/.`,
    });
  }
  return { findings, readouts: [] };
}

function planFor(
  ctx: Ctx,
  moduleIds: string[],
  registry: Registry,
): Action[] | null {
  const targets = ctx.claude.houseConfig?.targets?.length
    ? ctx.claude.houseConfig.targets
    : ctx.targets;
  try {
    return buildPlan(
      ctx,
      {
        moduleIds,
        targets,
        seedChangesetConfig: false,
        moduleOptions: resolveModuleOptions(
          registry,
          moduleIds,
          ctx.claude.houseConfig?.moduleOptions,
        ),
      },
      registry,
    );
  } catch {
    return null;
  }
}
