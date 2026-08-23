import { hookCommand } from './hook-wiring.js';

export interface HookEntry {
  type: 'command';
  command: string;
  statusMessage?: string;
  /** A harness-evaluated condition. The hook runs only when it is truthy. */
  if?: string;
  /** Seconds the harness waits before treating the hook as failed. */
  timeout?: number;
  /** True when the harness should not block on this hook's completion. */
  async?: boolean;
  [key: string]: unknown;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

export interface Permissions {
  allow?: string[];
  deny?: string[];
  ask?: string[];
}

/** A .claude/settings.json document. Unknown keys pass through untouched. */
export interface Settings {
  permissions?: Permissions;
  hooks?: Record<string, HookGroup[]>;
  statusLine?: unknown;
  outputStyle?: string;
  [key: string]: unknown;
}

/** A module's contribution to settings.json. Additive by construction. */
export interface SettingsFragment {
  permissions?: Permissions;
  hooks?: Record<string, HookGroup[]>;
  statusLine?: unknown;
  [key: string]: unknown;
}

export interface SettingsChange {
  kind: 'permission' | 'hook' | 'remove-hook' | 'statusLine';
  detail: string;
}

export interface SettingsPlan {
  dest: string;
  existedBefore: boolean;
  changes: SettingsChange[];
  /** Rendered file text. Absent only on a plan built purely to carry removals. */
  text?: string;
}

/** The hooks + permissions houserules contributed, recorded so update/doctor can
 * reconcile precisely instead of guessing which entries are houserules'. */
export interface SettingsSignature {
  hooks: { event: string; matcher: string | null; script: string | null }[];
  permissions: string[];
}

const KIT_SCRIPT_RE = /([\w-]+\.mjs)\b/g;

function normalizeCommand(cmd: unknown): string {
  return String(cmd ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function kitBasenames(cmd: unknown): string[] {
  return [...String(cmd ?? '').matchAll(KIT_SCRIPT_RE)].map((m) => m[1]!);
}

// Every command format houserules has ever emitted, oldest first, before hookCommand grew a
// guard. Kept as exact whitespace-normalized strings, since the shape check below only covers
// the current guarded form.
const KIT_STOCK_FORMATS: ((basename: string) => string)[] = [
  (name) => `node "$CLAUDE_PROJECT_DIR/.claude/scripts/${name}"`,
  // The guarded wrapper before the 2026-08-20 sweep moved the fallback to stderr. Installs
  // updated before that carry this form, and it is the population issue 86 was filed about.
  (name) =>
    `[ -f "$CLAUDE_PROJECT_DIR/.claude/scripts/${name}" ] && exec node "$CLAUDE_PROJECT_DIR/.claude/scripts/${name}" || echo "[houserules] ${name} missing. Run: npx houserules update"`,
  // The same wrapper from before the agent-kit to houserules rename.
  (name) =>
    `[ -f "$CLAUDE_PROJECT_DIR/.claude/scripts/${name}" ] && exec node "$CLAUDE_PROJECT_DIR/.claude/scripts/${name}" || echo "[kit] ${name} missing — run: npx agent-kit update"`,
];

// A placeholder basename, standing in for hookCommand's own scriptName parameter so the shape
// pattern below is derived from hookCommand's actual output rather than a second, hand-copied
// literal that could drift from it.
const SHAPE_PLACEHOLDER = 'ZZZKITSCRIPTPLACEHOLDERZZZ';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stockShapePattern(): RegExp {
  const template = normalizeCommand(hookCommand(SHAPE_PLACEHOLDER));
  const withCapture = escapeRegExp(template)
    .split(SHAPE_PLACEHOLDER)
    .join('([\\w-]+\\.mjs)');
  return new RegExp(`^${withCapture}$`);
}

/**
 * True when `command` is a form houserules itself would emit to run `scriptBasename`: the
 * current guarded wrapper hookCommand builds, a known historical stock string, or anything
 * else matching that wrapper's shape for this basename. A user's edited variant, whether extra
 * flags, a different guard, or a custom fallback message, never matches, so `mergeSettings` and
 * `reconcileSettings` both leave it untouched rather than silently upgrading or dropping it.
 */
export function isKitStockCommand(
  command: unknown,
  scriptBasename: string,
): boolean {
  const normalized = normalizeCommand(command);
  if (normalized === normalizeCommand(hookCommand(scriptBasename))) return true;
  if (
    KIT_STOCK_FORMATS.some(
      (f) => normalizeCommand(f(scriptBasename)) === normalized,
    )
  )
    return true;
  const match = stockShapePattern().exec(normalized);
  return match?.[1] === scriptBasename;
}

type HookMatch =
  | { kind: 'none' }
  | { kind: 'exact' }
  | { kind: 'stock-upgrade'; hook: HookEntry }
  | { kind: 'user-variant' };

function matchExistingHook(
  existingGroups: HookGroup[] | undefined,
  candidateCommand: string,
): HookMatch {
  const normalized = normalizeCommand(candidateCommand);
  const candidateBases = kitBasenames(candidateCommand);
  for (const group of existingGroups ?? []) {
    for (const hook of group?.hooks ?? []) {
      if (normalizeCommand(hook.command) === normalized)
        return { kind: 'exact' };
    }
  }
  for (const group of existingGroups ?? []) {
    for (const hook of group?.hooks ?? []) {
      const matchedBase = kitBasenames(hook.command).find((b) =>
        candidateBases.includes(b),
      );
      if (!matchedBase) continue;
      if (isKitStockCommand(hook.command, matchedBase))
        return { kind: 'stock-upgrade', hook };
      return { kind: 'user-variant' };
    }
  }
  return { kind: 'none' };
}

// Keys houserules contributes as one scalar or object rather than a list, so the
// array-append rules do not fit them. Set only when the user has none.
const SINGLE_VALUE_KEYS = ['statusLine'] as const;

/** Sets a single-value key only when the user has none yet — never clobbers one they set. */
function mergeSingleValueKeys(
  merged: Settings,
  fragment: SettingsFragment,
  changes: SettingsChange[],
): void {
  for (const key of SINGLE_VALUE_KEYS) {
    if (fragment[key] === undefined) continue;
    if (merged[key] !== undefined) continue;
    merged[key] = structuredClone(fragment[key]);
    changes.push({ kind: key, detail: 'set (was unset)' });
  }
}

/** Adds each fragment permission entry as a set-union on exact strings, per allow/deny/ask list. */
function mergePermissions(
  merged: Settings,
  fragment: SettingsFragment,
  changes: SettingsChange[],
): void {
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
}

/**
 * Adds each fragment hook, upgrading a byte-for-byte historical stock command in place and
 * leaving a user's edited variant or an already-present houserules hook untouched.
 */
function mergeHooks(
  merged: Settings,
  fragment: SettingsFragment,
  changes: SettingsChange[],
): void {
  for (const [event, groups] of Object.entries(fragment.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks ?? []) {
        const match = matchExistingHook(merged.hooks?.[event], hook.command);
        if (match.kind === 'exact' || match.kind === 'user-variant') continue;
        if (match.kind === 'stock-upgrade') {
          const base = kitBasenames(hook.command)[0] ?? '';
          match.hook.command = hook.command;
          changes.push({
            kind: 'hook',
            detail: `${event}${group.matcher ? `(${group.matcher})` : ''}: ${base} (upgraded)`,
          });
          continue;
        }
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
}

/**
 * Every hook entry across a fragment list, flattened with the event it belongs to.
 *
 * The settings hook shape nests four deep, fragment to event to group to hook, and two
 * callers walked all four inline. Flattening once keeps each caller at one level and means
 * a change to the shape has one place to land rather than two.
 */
function* eachHook(
  fragments: SettingsFragment[],
): Generator<{ event: string; group: HookGroup; hook: HookEntry }> {
  for (const fragment of fragments)
    for (const [event, groups] of Object.entries(fragment.hooks ?? {}))
      for (const group of groups ?? [])
        for (const hook of group.hooks ?? []) yield { event, group, hook };
}

/**
 * Folds one module's settings fragment into the existing file. Pure, with no filesystem
 * access, so the dry-run preview and the real write agree.
 *
 * The safety contract: user entries are never removed, rewritten, or reordered, and houserules
 * entries append. Permissions merge as a set-union on exact strings. A hook counts as
 * already present when an existing command normalizes to the same string or mentions the
 * same houserules script basename, and a user's edited variant always wins over houserules' stock
 * version. The one exception is an existing command that is byte-for-byte a known
 * historical stock form (see `KIT_STOCK_FORMATS`), which houserules upgrades in place and
 * reports. Everything else in the file passes through untouched.
 */
export function mergeSettings(
  existing: Settings | null,
  fragment: SettingsFragment,
): { merged: Settings; changes: SettingsChange[] } {
  const merged: Settings = structuredClone(existing ?? {});
  const changes: SettingsChange[] = [];

  mergeSingleValueKeys(merged, fragment, changes);
  mergePermissions(merged, fragment, changes);
  mergeHooks(merged, fragment, changes);

  return { merged, changes };
}

/**
 * Drops hook entries whose command references one of `scriptBasenames`, without touching,
 * rewriting, or reordering any other hook. Empty groups and events left behind are
 * removed so the file stays clean. User hooks never reference a houserules script basename, so
 * they are structurally untouched.
 */
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
 *   from ours, so this can in principle remove a line the user also wanted. Which is
 *   why disabling reports every change it makes rather than doing it silently.
 * - Anything houserules never contributed is not even considered.
 *
 * User hooks never reference a houserules script basename, so they are structurally
 * untouched. The same property `removeHooksByScript` relies on.
 */
export function removeSettingsFragments(
  existing: Settings | null,
  removed: SettingsFragment[],
  kept: SettingsFragment[],
): { merged: Settings; changes: SettingsChange[] } {
  const scriptsOf = (fragments: SettingsFragment[]): Set<string> => {
    const out = new Set<string>();
    for (const { hook } of eachHook(fragments))
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

/**
 * Drops a hook entry that update or doctor recognize as houserules' own but that no longer has
 * anywhere to come from: it is in the previously `recorded` signature, no CURRENT fragment
 * declares that {event, matcher, script} tuple, and the on-disk command still reads as
 * houserules stock. That third condition is the safety check `removeHooksByScript` does not
 * need, because a whole-signature reconcile runs even when the module that wired a hook stops
 * shipping it, and a stale entry that the user has since hand-edited must survive exactly like
 * any other user variant does.
 *
 * `recorded` absent means there is nothing to reconcile against, such as a manifest written
 * before this feature existed, so nothing is dropped.
 *
 * @returns The reconciled settings, and every tuple actually dropped, for the caller to report.
 */
export function reconcileSettings(
  existing: Settings | null,
  fragments: SettingsFragment[],
  recorded: SettingsSignature | undefined,
): { merged: Settings; dropped: SettingsSignature['hooks'] } {
  const merged: Settings = structuredClone(existing ?? {});
  const dropped: SettingsSignature['hooks'] = [];
  if (!recorded || !merged.hooks) return { merged, dropped };

  const keyOf = (
    event: string,
    matcher: string | null,
    script: string | null,
  ) => `${event}|${matcher ?? ''}|${script}`;

  const declared = new Set<string>();
  for (const { event, group, hook } of eachHook(fragments)) {
    const script = kitBasenames(hook.command)[0] ?? null;
    declared.add(keyOf(event, group.matcher ?? null, script));
  }

  const recordedKeys = new Set(
    recorded.hooks.map((h) => keyOf(h.event, h.matcher, h.script)),
  );

  for (const [event, groups] of Object.entries(merged.hooks)) {
    const keptGroups: HookGroup[] = [];
    for (const group of groups ?? []) {
      const keptHooks = (group?.hooks ?? []).filter((hook) => {
        const script = kitBasenames(hook.command)[0] ?? null;
        const key = keyOf(event, group.matcher ?? null, script);
        if (!recordedKeys.has(key) || declared.has(key)) return true;
        if (!script || !isKitStockCommand(hook.command, script)) return true;
        dropped.push({ event, matcher: group.matcher ?? null, script });
        return false;
      });
      if (keptHooks.length) keptGroups.push({ ...group, hooks: keptHooks });
    }
    if (keptGroups.length) merged.hooks[event] = keptGroups;
    else delete merged.hooks[event];
  }
  if (merged.hooks && !Object.keys(merged.hooks).length) delete merged.hooks;

  return { merged, dropped };
}

/**
 * Derives which hooks and permissions houserules contributed. Recorded in the manifest so
 * update and doctor can reconcile precisely instead of guessing which entries are ours.
 */
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
    for (const { event, group, hook } of eachHook([fragment])) {
      const script = kitBasenames(hook.command)[0] ?? null;
      const key = `${event}|${group.matcher ?? ''}|${script}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hooks.push({ event, matcher: group.matcher ?? null, script });
    }
  }
  return { hooks, permissions: [...permissions] };
}

/** @throws SyntaxError. The caller decides what that means. houserules never repairs user JSON. */
export function parseSettingsText(text: string): Settings {
  return JSON.parse(text);
}

export function renderSettings(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
