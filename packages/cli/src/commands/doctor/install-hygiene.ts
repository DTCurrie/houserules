import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Ctx } from '../../detect.js';
import { isGuardedHookCommand } from '@houserules/api';
import type { CheckResult, Finding, Settings } from '@houserules/api';
import { isKitStockCommand } from '@houserules/api/internal';

import { allHookCommands } from './settings-wiring.js';

const KIT_SCRIPT_RE = /(\.claude\/scripts\/[^\s'"]+\.mjs)/;
const KIT_SCRIPT_BASENAME_RE = /([\w-]+\.mjs)/;
const EXIT_ONE_FALLBACK_RE = /exit 1; \}$/;
const NON_BLOCKING_EVENTS = ['SessionStart', 'Stop'];
const PROJECT_DIR_PREFIX = '$CLAUDE_PROJECT_DIR/';
const HOOK_TOKEN_RE = /^[^$\s]*\/[^$\s]+\.(?:mjs|js|sh)$/;
const SECRET_PREFIXES = ['sk-', 'ghp_', 'github_pat_', 'AKIA', 'xoxb-'];
const CONFIG_SURFACE_FILES = [
  'houserules.config.json',
  'settings.json',
  'settings.local.json',
];

function stripQuotes(token: string): string {
  if (token.length < 2) return token;
  const first = token[0];
  const last = token[token.length - 1];
  if ((first === '"' || first === "'") && first === last)
    return token.slice(1, -1);
  return token;
}

function findUnguardedScriptFindings(commands: string[]): string[] {
  const readouts: string[] = [];
  for (const command of commands) {
    const match = command.match(KIT_SCRIPT_RE);
    const scriptPath = match?.[1];
    if (scriptPath && !isGuardedHookCommand(command)) readouts.push(scriptPath);
  }
  return readouts;
}

function findMissingScriptFindings(
  root: string,
  commands: string[],
): Finding[] {
  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (const command of commands) {
    for (const rawToken of command.split(/\s+/)) {
      const unquoted = stripQuotes(rawToken);
      const token = unquoted.startsWith(PROJECT_DIR_PREFIX)
        ? unquoted.slice(PROJECT_DIR_PREFIX.length)
        : unquoted;
      if (!HOOK_TOKEN_RE.test(token) || reported.has(token)) continue;
      reported.add(token);
      if (!existsSync(join(root, token))) {
        findings.push({
          level: 'WARN',
          msg: `hook command references missing script "${token}" — fix the path or remove the hook`,
        });
      }
    }
  }
  return findings;
}

function findExitOneFallbackFindings(settings: Settings): Finding[] {
  const findings: Finding[] = [];
  for (const event of NON_BLOCKING_EVENTS) {
    for (const group of settings.hooks?.[event] ?? []) {
      for (const hook of group.hooks ?? []) {
        const command = hook.command?.trim();
        const script = command?.match(KIT_SCRIPT_BASENAME_RE)?.[1];
        if (!command || !script) continue;
        if (!isKitStockCommand(command, script)) continue;
        if (!EXIT_ONE_FALLBACK_RE.test(command)) continue;
        findings.push({
          level: 'WARN',
          msg: `${event} hook for ${script} exits 1 when the script is missing, so a fresh clone shows a hook error on every ${event} — run: npx houserules update`,
        });
      }
    }
  }
  return findings;
}

function secretPrefixRegex(prefix: string): RegExp {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}[A-Za-z0-9_-]{8,}`);
}

function findSecretShapedFindings(root: string): {
  findings: Finding[];
  filesScanned: number;
} {
  const findings: Finding[] = [];
  let filesScanned = 0;
  for (const fileName of CONFIG_SURFACE_FILES) {
    const filePath = join(root, '.claude', fileName);
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    filesScanned += 1;
    for (const prefix of SECRET_PREFIXES) {
      if (secretPrefixRegex(prefix).test(text)) {
        findings.push({
          level: 'WARN',
          msg: `.claude/${fileName} contains a value shaped like a ${prefix} secret — remove it and rotate the credential`,
        });
      }
    }
  }
  return { findings, filesScanned };
}

/**
 * Hygiene scan over the installed agent surface: settings hook commands and committed
 * config. Read-only, and every finding is info or warn, since nothing here is a broken
 * install. The rule set is deliberately small and near-zero false positive.
 */
export function checkInstallHygiene(root: string, ctx: Ctx): CheckResult {
  const findings: Finding[] = [];
  const readouts: string[] = [];

  const commands =
    ctx.claude.settingsExists && ctx.claude.settings
      ? allHookCommands(ctx.claude.settings)
      : [];

  const unguardedScripts = findUnguardedScriptFindings(commands);
  for (const scriptPath of unguardedScripts) {
    readouts.push(
      `hook command runs ${scriptPath} without the "[ -f ... ] && exec node" existence guard`,
    );
  }

  findings.push(...findMissingScriptFindings(root, commands));
  if (ctx.claude.settingsExists && ctx.claude.settings)
    findings.push(...findExitOneFallbackFindings(ctx.claude.settings));

  const { findings: secretFindings, filesScanned } =
    findSecretShapedFindings(root);
  findings.push(...secretFindings);

  if (commands.length > 0 || filesScanned > 0) {
    readouts.push(
      `install hygiene: ${commands.length} hook command(s) scanned, ${filesScanned} config file(s) scanned`,
    );
  }

  return { findings, readouts };
}
