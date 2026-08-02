import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readJson } from '../../../payload-dist/scripts/lib/workspaces.mjs';
import type { Ctx } from '../../detect.js';
import type { Settings } from '../../merge-settings.js';
import { verifyDefaultsFor } from '../../render.js';
import type { CheckResult, Finding } from './finding.js';

// The frontmatter `name`, not the `kit-terse` filename slug. Claude Code matches
// outputStyle on the name, so the slug silently falls back to Default.
const TERSE_STYLE_NAME = 'Kit Terse';
const TERSE_STYLE_SLUG = 'kit-terse';

const activeOutputStyle = (settings: Settings | null | undefined) =>
  typeof settings?.outputStyle === 'string' ? settings.outputStyle : null;

/** Whether each installed module has what it needs to actually do its job. */
export function checkModuleHealth(root: string, ctx: Ctx): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];
  const manifest = ctx.claude.manifest;
  const config = ctx.claude.kitConfig;
  const installed = (id: string) => Boolean(manifest?.modules?.includes(id));

  if (installed('changesets')) {
    if (!ctx.changesets.configExists)
      findings.push({
        level: 'ERROR',
        msg: 'changesets module installed but .changeset/config.json is missing',
      });
    else if (ctx.changesets.invocation === 'external-cli') {
      findings.push({
        level: 'WARN',
        msg: 'changesets CLI not installed (pnpx/npx works; add @changesets/cli as a devDependency for release flows)',
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

  if (installed('rename') && !ctx.typescript) {
    findings.push({
      level: 'WARN',
      msg: 'rename module installed but no typescript dependency detected — rename.mjs will fail',
    });
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

  // Installing the style file does not activate it.
  if (installed('terse-style')) {
    const local = readJson<Settings>(
      join(root, '.claude', 'settings.local.json'),
    );
    const active =
      activeOutputStyle(local) ?? activeOutputStyle(ctx.claude.settings);
    if (active === TERSE_STYLE_NAME) {
      readouts.push(`terse-style: ACTIVE (outputStyle "${TERSE_STYLE_NAME}")`);
    } else if (active === TERSE_STYLE_SLUG) {
      findings.push({
        level: 'WARN',
        msg: `terse-style: outputStyle "${TERSE_STYLE_SLUG}" is the filename slug and silently falls back to Default — set outputStyle to "${TERSE_STYLE_NAME}" (the frontmatter name)`,
      });
    } else if (active) {
      readouts.push(
        `terse-style: INACTIVE — installed, but outputStyle "${active}" is active instead`,
      );
    } else {
      readouts.push(
        `terse-style: INACTIVE — installed but no outputStyle set; activate via /config → Output style → "${TERSE_STYLE_NAME}", or set "outputStyle": "${TERSE_STYLE_NAME}"`,
      );
    }
  }

  return { findings, readouts };
}
