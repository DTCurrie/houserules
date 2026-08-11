export interface HookEntry {
  type: 'command';
  command: string;
  statusMessage?: string;
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

/** The hooks + permissions the kit contributed, recorded so update/doctor can
 * reconcile precisely instead of guessing which entries are the kit's. */
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

// Every command format the kit has ever emitted, oldest first. Only these exact
// whitespace-normalized strings are eligible for in-place upgrade.
const KIT_STOCK_FORMATS: ((basename: string) => string)[] = [
  (name) => `node "$CLAUDE_PROJECT_DIR/.claude/scripts/${name}"`,
];

function isRecognizedKitStock(command: unknown, basename: string): boolean {
  const normalized = normalizeCommand(command);
  return KIT_STOCK_FORMATS.some(
    (f) => normalizeCommand(f(basename)) === normalized,
  );
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
      if (isRecognizedKitStock(hook.command, matchedBase))
        return { kind: 'stock-upgrade', hook };
      return { kind: 'user-variant' };
    }
  }
  return { kind: 'none' };
}

// Keys the kit contributes as one scalar or object rather than a list, so the
// array-append rules do not fit them. Set only when the user has none.
const SINGLE_VALUE_KEYS = ['statusLine'] as const;

/**
 * Folds one module's settings fragment into the existing file. Pure, with no filesystem
 * access, so the dry-run preview and the real write agree.
 *
 * The safety contract: user entries are never removed, rewritten, or reordered, and kit
 * entries append. Permissions merge as a set-union on exact strings. A hook counts as
 * already present when an existing command normalizes to the same string or mentions the
 * same kit script basename, and a user's edited variant always wins over the kit's stock
 * version. The one exception is an existing command that is byte-for-byte a known
 * historical stock form (see `KIT_STOCK_FORMATS`), which the kit upgrades in place and
 * reports. Everything else in the file passes through untouched.
 */
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
 * leaving a user's edited variant or an already-present kit hook untouched.
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
 * removed so the file stays clean. User hooks never reference a kit script basename, so
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
 * - Anything the kit never contributed is not even considered.
 *
 * User hooks never reference a kit script basename, so they are structurally
 * untouched. The same property `removeHooksByScript` relies on.
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

/**
 * Derives which hooks and permissions the kit contributed. Recorded in the manifest so
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

/** @throws SyntaxError. The caller decides what that means. The kit never repairs user JSON. */
export function parseSettingsText(text: string): Settings {
  return JSON.parse(text);
}

export function renderSettings(settings: Settings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
