import { installedModuleIds } from '../../installed-modules.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Ctx } from '../../detect.js';
import type { CheckResult, Finding, Settings } from '@houserules/api';
import {
  HOOK_DISPATCH_SCRIPT,
  HOOK_WIRING_PATH,
} from '@houserules/api/internal';
import type { HookWiring } from '@houserules/api/internal';

// module id → hook script that must appear in a settings.json hook command.
export const HOOK_SCRIPTS: Record<string, string[]> = {
  core: ['guard-bash.mjs', 'ledger-inject.mjs', 'notice-interim.mjs'],
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

/** The dispatcher's wiring file as doctor found it. */
type HookWiringRead =
  | { kind: 'absent' }
  | { kind: 'unparseable'; reason: string }
  | { kind: 'read'; wiring: HookWiring };

function isHookWiring(value: unknown): value is HookWiring {
  if (typeof value !== 'object' || value === null) return false;
  const events = (value as { events?: unknown }).events;
  if (typeof events !== 'object' || events === null) return false;
  return Object.values(events).every(
    (entries) =>
      Array.isArray(entries) &&
      entries.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { script?: unknown }).script === 'string',
      ),
  );
}

/** Reads {@link HOOK_WIRING_PATH}. Never throws: a missing or malformed file is a result. */
export function readHookWiring(root: string): HookWiringRead {
  let text: string;
  try {
    text = readFileSync(join(root, HOOK_WIRING_PATH), 'utf8');
  } catch {
    return { kind: 'absent' };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (isHookWiring(parsed)) return { kind: 'read', wiring: parsed };
    return { kind: 'unparseable', reason: 'no events map of script entries' };
  } catch (error) {
    return { kind: 'unparseable', reason: (error as Error).message };
  }
}

/** Every script the wiring file dispatches, across events. */
export function wiredScripts(read: HookWiringRead): Set<string> {
  if (read.kind !== 'read') return new Set();
  return new Set(
    Object.values(read.wiring.events).flatMap((entries) =>
      entries.map((entry) => entry.script),
    ),
  );
}

function eventHasDispatcher(
  settings: Settings | null | undefined,
  event: string,
): boolean {
  return (settings?.hooks?.[event] ?? []).some((group) =>
    (group?.hooks ?? []).some((hook) =>
      String(hook.command ?? '').includes(HOOK_DISPATCH_SCRIPT),
    ),
  );
}

/**
 * The wiring file's own problems on an install whose settings.json runs the dispatcher:
 * a missing or malformed file runs no dispatched hook, and an event the file wires with no
 * dispatcher entry in settings.json never fires.
 */
function wiringFileFindings(
  read: HookWiringRead,
  settings: Settings | null | undefined,
): Finding[] {
  if (read.kind === 'absent')
    return [
      {
        level: 'WARN',
        msg: `${HOOK_WIRING_PATH} is missing, so the ${HOOK_DISPATCH_SCRIPT} entries in .claude/settings.json run no hooks — run: npx houserules update`,
      },
    ];
  if (read.kind === 'unparseable')
    return [
      {
        level: 'WARN',
        msg: `${HOOK_WIRING_PATH} unparseable (${read.reason}), so no dispatched hook runs — run: npx houserules update`,
      },
    ];
  return Object.entries(read.wiring.events)
    .filter(
      ([event, entries]) =>
        entries.length > 0 && !eventHasDispatcher(settings, event),
    )
    .map(([event]) => ({
      level: 'WARN' as const,
      msg: `${HOOK_WIRING_PATH} wires ${event} hooks but .claude/settings.json has no ${HOOK_DISPATCH_SCRIPT} entry for ${event}, so they never run — run: npx houserules update`,
    }));
}

/** WARNs for each installed module whose hook script is wired neither directly nor through the dispatcher. */
function moduleScriptFindings(
  ctx: Ctx,
  wiringRead: HookWiringRead,
  dispatched: Set<string>,
): Finding[] {
  const findings: Finding[] = [];
  const manifest = ctx.claude.manifest;
  const config = ctx.claude.houseConfig;
  const commands = allHookCommands(ctx.claude.settings);
  const isDispatchedInstall = commands.some((command) =>
    command.includes(HOOK_DISPATCH_SCRIPT),
  );
  if (isDispatchedInstall)
    findings.push(...wiringFileFindings(wiringRead, ctx.claude.settings));
  const wiredIn = isDispatchedInstall
    ? `${HOOK_WIRING_PATH} or .claude/settings.json`
    : '.claude/settings.json';
  const lintFixWired = (config?.targets ?? []).some(
    (target) => target.fixCommands?.length,
  );
  for (const moduleId of installedModuleIds(config, manifest) ?? []) {
    // lint-fix deliberately leaves its Stop hooks unwired when no target has a fix
    // command (dfdc87). That gap is intentional.
    if (moduleId === 'lint-fix' && !lintFixWired) continue;
    for (const scriptName of HOOK_SCRIPTS[moduleId] ?? []) {
      if (dispatched.has(scriptName)) continue;
      if (!commands.some((command) => command.includes(scriptName))) {
        findings.push({
          level: 'WARN',
          msg: `module "${moduleId}": hook script ${scriptName} not wired in ${wiredIn}`,
        });
      }
    }
  }
  return findings;
}

/** A WARN when settings.local.json wires a houserules hook script with a command other than the managed one. */
function settingsLocalDriftFindings(
  root: string,
  ctx: Ctx,
  dispatched: Set<string>,
): Finding[] {
  try {
    const local = JSON.parse(
      readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'),
    );
    const kitCommands = allHookCommands(ctx.claude.settings);
    const drifted = allHookCommands(local).filter((localCommand) => {
      const scriptName = KIT_HOOK_SCRIPT_RE.exec(localCommand)?.[0];
      if (!scriptName) return false;
      // A script the dispatcher runs has no managed settings command, so any local one runs beside it.
      if (dispatched.has(scriptName)) return true;
      const managed = kitCommands.filter((command) =>
        command.includes(scriptName),
      );
      return managed.length > 0 && !managed.includes(localCommand);
    });
    if (!drifted.length) return [];
    return [
      {
        level: 'WARN',
        msg: 'settings.local.json wires a houserules hook script with a command that differs from the managed one, so it runs beside it and drifts from updates',
      },
    ];
  } catch {
    // local file is the user's business
    return [];
  }
}

/**
 * Whether every installed module's hook scripts are wired, either directly in
 * .claude/settings.json or through the dispatcher's {@link HOOK_WIRING_PATH}.
 */
export function checkSettingsWiring(root: string, ctx: Ctx): CheckResult {
  const findings: Finding[] = [];
  const manifest = ctx.claude.manifest;
  const wiringRead = readHookWiring(root);
  const dispatched = wiredScripts(wiringRead);

  if (manifest && ctx.claude.settingsExists && !ctx.claude.settingsParseError) {
    findings.push(...moduleScriptFindings(ctx, wiringRead, dispatched));
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

  if (ctx.claude.settingsLocalExists)
    findings.push(...settingsLocalDriftFindings(root, ctx, dispatched));

  return { findings, readouts: [] };
}
