import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Ctx } from '../../detect.js';
import type { CheckResult, Finding, Settings } from '@houserules/api';

// module id → hook script that must appear in a settings.json hook command.
export const HOOK_SCRIPTS: Record<string, string[]> = {
  core: ['guard-bash.mjs', 'ledger-inject.mjs'],
  'lint-fix': ['lint-format-fix.mjs'],
  changesets: ['changeset-check.mjs'],
  'session-context': ['session-context.mjs'],
  'debug-session': ['debug-session-check.mjs'],
  'read-guard': ['guard-read.mjs'],
  regen: ['regen-on-edit.mjs'],
};

/**
 * Every hook script a module might wire, derived from {@link HOOK_SCRIPTS} rather than
 * restated, so a script added to that map is covered here without a second edit.
 * Three script names had once drifted out of a hand-maintained copy of this list.
 */
export const KIT_HOOK_SCRIPT_RE = new RegExp(
  `(${Array.from(new Set(Object.values(HOOK_SCRIPTS).flat()))
    .map((scriptName) => scriptName.replace(/\.mjs$/, ''))
    .join('|')})\\.mjs`,
);

export function allHookCommands(
  settings: Settings | null | undefined,
): string[] {
  const commands: string[] = [];
  for (const groups of Object.values(settings?.hooks ?? {})) {
    for (const group of groups ?? []) {
      for (const hook of group?.hooks ?? [])
        commands.push(String(hook.command ?? ''));
    }
  }
  return commands;
}

/** Whether every installed module's hook scripts are wired into .claude/settings.json. */
export function checkSettingsWiring(root: string, ctx: Ctx): CheckResult {
  const findings: Finding[] = [];
  const manifest = ctx.claude.manifest;
  const config = ctx.claude.houseConfig;

  if (manifest && ctx.claude.settingsExists && !ctx.claude.settingsParseError) {
    const commands = allHookCommands(ctx.claude.settings);
    const lintFixWired = (config?.targets ?? []).some(
      (t) => t.fixCommands?.length,
    );
    for (const moduleId of manifest.modules ?? []) {
      // lint-fix deliberately leaves its Stop hooks unwired when no target has a fix
      // command (dfdc87). That gap is intentional.
      if (moduleId === 'lint-fix' && !lintFixWired) continue;
      for (const scriptName of HOOK_SCRIPTS[moduleId] ?? []) {
        if (!commands.some((c) => c.includes(scriptName))) {
          findings.push({
            level: 'WARN',
            msg: `module "${moduleId}": hook script ${scriptName} not wired in .claude/settings.json`,
          });
        }
      }
    }
  } else if (manifest && !ctx.claude.settingsExists) {
    findings.push({
      level: 'ERROR',
      msg: 'houserules installed but .claude/settings.json is missing (hooks unwired) — rerun init',
    });
  }

  if (ctx.claude.settingsParseError)
    findings.push({
      level: 'ERROR',
      msg: `.claude/settings.json unparseable: ${ctx.claude.settingsParseError}`,
    });

  if (ctx.claude.settingsLocalExists) {
    try {
      const local = JSON.parse(
        readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'),
      );
      const kitCommands = allHookCommands(ctx.claude.settings);
      const drifted = allHookCommands(local).filter((localCommand) => {
        const scriptName = KIT_HOOK_SCRIPT_RE.exec(localCommand)?.[0];
        if (!scriptName) return false;
        const managed = kitCommands.filter((c) => c.includes(scriptName));
        return managed.length > 0 && !managed.includes(localCommand);
      });
      if (drifted.length)
        findings.push({
          level: 'WARN',
          msg: 'settings.local.json wires a houserules hook script with a command that differs from the managed one, so it runs beside it and drifts from updates',
        });
    } catch {
      /* local file is the user's business */
    }
  }

  return { findings, readouts: [] };
}
