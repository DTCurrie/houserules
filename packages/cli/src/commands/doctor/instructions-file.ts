import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CheckResult, Finding } from '@houserules/api';
import type { Ctx } from '../../detect.js';
import { claudeMdRegion } from '../../core/claude-md-region.js';
import { parseImports } from './resident-surface.js';

// Inspected at the repo root only: the check cannot know which ancestor directory the user
// launches Claude Code from, and root is where houserules writes.
const CLAUDE_MD_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'];

// The plugin id was `agents-md@builtin` before Claude Code v2.1.285.
const PLUGIN_IDS = ['cc-plugin-agents-md@builtin', 'agents-md@builtin'];
const LOADS_BOTH = 'claude-md-and-agents-md';

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Whether the user's own settings load both instruction files. Claude Code ignores this key
 * in project and local settings, so only the user file is read. A missing or unparseable
 * file counts as not set.
 */
function userLoadsBoth(userSettingsPath: string): boolean {
  const text = readText(userSettingsPath);
  if (text === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  const configs = (parsed as { pluginConfigs?: unknown } | null)?.pluginConfigs;
  if (typeof configs !== 'object' || configs === null) return false;
  return PLUGIN_IDS.some((id) => {
    const entry = (configs as Record<string, unknown>)[id] as
      { options?: { instructionFiles?: unknown } } | undefined;
    return entry?.options?.instructionFiles === LOADS_BOTH;
  });
}

/**
 * Warns when a CLAUDE.md silences the houserules block in AGENTS.md. Claude Code reads
 * AGENTS.md only when no CLAUDE.md file exists, unless the user's settings load both or the
 * CLAUDE.md imports it.
 */
export function checkInstructionsFile(
  root: string,
  ctx: Ctx,
  userSettingsPath = join(homedir(), '.claude', 'settings.json'),
): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];

  const agentsText = readText(join(root, 'AGENTS.md'));
  if (agentsText === null || !agentsText.includes(claudeMdRegion.start))
    return { findings, readouts };

  readouts.push(
    `instructions file (${ctx.claude.instructionsFile}): houserules block present in AGENTS.md`,
  );

  const existing = CLAUDE_MD_FILES.filter((rel) => existsSync(join(root, rel)));
  const first = existing[0];
  if (first === undefined) return { findings, readouts };

  const importsAgents = existing.some((rel) =>
    parseImports(readText(join(root, rel)) ?? '').some(
      (spec) => spec === 'AGENTS.md' || spec === './AGENTS.md',
    ),
  );
  if (importsAgents || userLoadsBoth(userSettingsPath))
    return { findings, readouts };

  findings.push({
    level: 'WARN',
    msg:
      `${first} silences AGENTS.md: Claude Code reads only the CLAUDE.md files when one exists, so the houserules block in AGENTS.md never loads. ` +
      `Either add an \`@AGENTS.md\` line to ${first}, or set \`pluginConfigs["cc-plugin-agents-md@builtin"].options.instructionFiles\` to "${LOADS_BOTH}" in ~/.claude/settings.json`,
  });
  return { findings, readouts };
}
