// Pure settings.json merge (claude-kit CLI). No filesystem access here — apply.mjs
// and the dry-run preview both call this, so what you preview is what gets written.
//
// Rules (the safety contract):
// - User entries are never removed, rewritten, or reordered; kit entries append.
// - Permissions merge is a set-union on exact strings.
// - A hook is "already present" if an existing hook command normalizes to the same
//   string OR mentions the same kit script basename — a user's edited variant of a
//   kit hook always wins over the kit's stock version.
// - Anything else in the file passes through untouched.

import type {
  HookGroup,
  Settings,
  SettingsChange,
  SettingsFragment,
  SettingsSignature,
} from './types.js';

const KIT_SCRIPT_RE = /([\w-]+\.mjs)\b/g;

function normalizeCommand(cmd: unknown): string {
  return String(cmd ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function kitBasenames(cmd: unknown): string[] {
  return [...String(cmd ?? '').matchAll(KIT_SCRIPT_RE)].map((m) => m[1]!);
}

function hookAlreadyPresent(
  existingGroups: HookGroup[] | undefined,
  candidateCommand: string,
): boolean {
  const normalized = normalizeCommand(candidateCommand);
  const candidateBases = new Set(kitBasenames(candidateCommand));
  for (const group of existingGroups ?? []) {
    for (const hook of group?.hooks ?? []) {
      if (normalizeCommand(hook.command) === normalized) return true;
      if (kitBasenames(hook.command).some((b) => candidateBases.has(b)))
        return true;
    }
  }
  return false;
}

// fragment: { permissions?: {allow?: [], deny?: [], ask?: []},
//             hooks?: { EventName: [{ matcher?, hooks: [{type, command, ...}] }] } }
// → { merged, changes: [{kind, detail}] }
// Keys the kit may contribute as a single scalar/object value, set ONLY when the
// user has none (never clobber a user's global). The array-append rules above and
// the removal path below don't fit these — statusLine is one object, not a list.
const SINGLE_VALUE_KEYS = ['statusLine'] as const;

export function mergeSettings(
  existing: Settings | null,
  fragment: SettingsFragment,
): { merged: Settings; changes: SettingsChange[] } {
  const merged: Settings = structuredClone(existing ?? {});
  const changes: SettingsChange[] = [];

  for (const key of SINGLE_VALUE_KEYS) {
    if (fragment[key] === undefined) continue;
    if (merged[key] !== undefined) continue; // user already has one — never clobber
    merged[key] = structuredClone(fragment[key]);
    changes.push({ kind: key, detail: 'set (was unset)' });
  }

  for (const list of ['allow', 'deny', 'ask'] as const) {
    const additions = fragment.permissions?.[list];
    if (!additions?.length) continue;
    merged.permissions ??= {};
    merged.permissions[list] ??= [];
    const present = new Set(merged.permissions[list]);
    for (const entry of additions) {
      if (present.has(entry)) continue;
      merged.permissions[list].push(entry);
      present.add(entry);
      changes.push({ kind: 'permission', detail: `${list}: ${entry}` });
    }
  }

  for (const [event, groups] of Object.entries(fragment.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        if (hookAlreadyPresent(merged.hooks?.[event], hook.command)) continue;
        merged.hooks ??= {};
        merged.hooks[event] ??= [];
        // Reuse an existing group with the same matcher so the file stays tidy.
        const matcherOf = (g: HookGroup) => g.matcher ?? null;
        let target = merged.hooks[event].find(
          (g) => matcherOf(g) === (group.matcher ?? null),
        );
        if (!target) {
          target =
            group.matcher !== undefined
              ? { matcher: group.matcher, hooks: [] }
              : { hooks: [] };
          merged.hooks[event].push(target);
        }
        target.hooks ??= [];
        target.hooks.push(structuredClone(hook));
        const base =
          kitBasenames(hook.command)[0] ??
          normalizeCommand(hook.command).slice(0, 40);
        changes.push({
          kind: 'hook',
          detail: `${event}${group.matcher ? `(${group.matcher})` : ''}: ${base}`,
        });
      }
    }
  }

  return { merged, changes };
}

// The FIRST removal path (everything else here is additive). Surgically drop hook
// entries whose command references one of `scriptBasenames` — a kit script the
// current kit no longer ships — without touching, rewriting, or reordering any other
// hook. Empty groups/events left behind are removed so the file stays clean. User
// hooks (which never reference a kit script basename) are structurally untouched.
// → { merged, changes: [{kind:'remove-hook', detail}] }
export function removeHooksByScript(
  existing: Settings | null,
  scriptBasenames: string[],
): { merged: Settings; changes: SettingsChange[] } {
  const targets = new Set(scriptBasenames);
  const merged: Settings = structuredClone(existing ?? {});
  const changes: SettingsChange[] = [];
  if (!merged.hooks) return { merged, changes };

  for (const [event, groups] of Object.entries(merged.hooks)) {
    const keptGroups: HookGroup[] = [];
    for (const group of groups ?? []) {
      const keptHooks = (group?.hooks ?? []).filter((hook) => {
        const hit = kitBasenames(hook.command).find((b) => targets.has(b));
        if (hit)
          changes.push({
            kind: 'remove-hook',
            detail: `${event}${group.matcher ? `(${group.matcher})` : ''}: ${hit}`,
          });
        return !hit;
      });
      if (keptHooks.length) keptGroups.push({ ...group, hooks: keptHooks });
    }
    if (keptGroups.length) merged.hooks[event] = keptGroups;
    else delete merged.hooks[event];
  }
  if (merged.hooks && !Object.keys(merged.hooks).length) delete merged.hooks;
  return { merged, changes };
}

/**
 * Withdraw the settings contribution of modules being DISABLED, without disturbing
 * anything else. This is the inverse of mergeSettings, and it is deliberately
 * narrower than a generic deep-remove:
 *
 * - A hook is dropped only when its command references a script basename that a
 *   REMOVED fragment ships and no KEPT fragment still ships. Two modules wiring the
 *   same script means disabling one must not unwire the other.
 * - A permission is dropped only when a removed fragment contributed it and no kept
 *   fragment still does. A user's own identical permission string is indistinguishable
 *   from ours, so this can in principle remove a line the user also wanted — which is
 *   why disabling reports every change it makes rather than doing it silently.
 * - Anything the kit never contributed is not even considered.
 *
 * User hooks never reference a kit script basename, so they are structurally
 * untouched — the same property `removeHooksByScript` relies on.
 */
export function removeSettingsFragments(
  existing: Settings | null,
  removed: SettingsFragment[],
  kept: SettingsFragment[],
): { merged: Settings; changes: SettingsChange[] } {
  const scriptsOf = (fragments: SettingsFragment[]): Set<string> => {
    const out = new Set<string>();
    for (const fragment of fragments)
      for (const groups of Object.values(fragment.hooks ?? {}))
        for (const group of groups ?? [])
          for (const hook of group.hooks ?? [])
            for (const base of kitBasenames(hook.command)) out.add(base);
    return out;
  };
  const permissionsOf = (fragments: SettingsFragment[]): Set<string> => {
    const out = new Set<string>();
    for (const fragment of fragments)
      for (const list of ['allow', 'deny', 'ask'] as const)
        for (const entry of fragment.permissions?.[list] ?? [])
          out.add(`${list}:${entry}`);
    return out;
  };

  const keptScripts = scriptsOf(kept);
  const doomedScripts = [...scriptsOf(removed)].filter(
    (base) => !keptScripts.has(base),
  );
  const { merged, changes } = removeHooksByScript(existing, doomedScripts);

  const keptPermissions = permissionsOf(kept);
  for (const key of permissionsOf(removed)) {
    if (keptPermissions.has(key)) continue;
    const [list, ...rest] = key.split(':');
    const entry = rest.join(':');
    const bucket = merged.permissions?.[list as 'allow' | 'deny' | 'ask'];
    if (!bucket) continue;
    const next = bucket.filter((p) => p !== entry);
    if (next.length === bucket.length) continue;
    if (next.length) merged.permissions![list as 'allow'] = next;
    else delete merged.permissions![list as 'allow'];
    changes.push({ kind: 'permission', detail: `removed ${list}: ${entry}` });
  }
  if (merged.permissions && !Object.keys(merged.permissions).length)
    delete merged.permissions;

  return { merged, changes };
}

// The kit's settings SIGNATURE: the hooks + permissions the kit contributed, derived
// from the plan's merge-settings fragments. Recorded in the manifest so update/doctor
// can reconcile precisely (which entries are the kit's) instead of guessing.
export function settingsSignature(
  fragments: SettingsFragment[],
): SettingsSignature {
  const permissions = new Set<string>();
  const hooks: SettingsSignature['hooks'] = [];
  const seen = new Set<string>();
  for (const fragment of fragments ?? []) {
    for (const list of ['allow', 'deny', 'ask'] as const)
      for (const p of fragment.permissions?.[list] ?? [])
        permissions.add(`${list}:${p}`);
    for (const [event, groups] of Object.entries(fragment.hooks ?? {}))
      for (const group of groups ?? [])
        for (const hook of group.hooks ?? []) {
          const script = kitBasenames(hook.command)[0] ?? null;
          const key = `${event}|${group.matcher ?? ''}|${script}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hooks.push({ event, matcher: group.matcher ?? null, script });
        }
  }
  return { hooks, permissions: [...permissions] };
}

export function parseSettingsText(text: string): Settings {
  // Caller decides what a failure means; we never "repair" user JSON.
  return JSON.parse(text);
}

export function renderSettings(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
