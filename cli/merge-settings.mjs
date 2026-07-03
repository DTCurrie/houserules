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

const KIT_SCRIPT_RE = /([\w-]+\.mjs)\b/g;

function normalizeCommand(cmd) {
  return String(cmd ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function kitBasenames(cmd) {
  return [...String(cmd ?? '').matchAll(KIT_SCRIPT_RE)].map((m) => m[1]);
}

function hookAlreadyPresent(existingGroups, candidateCommand) {
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
export function mergeSettings(existing, fragment) {
  const merged = structuredClone(existing ?? {});
  const changes = [];

  for (const list of ['allow', 'deny', 'ask']) {
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
        const matcherOf = (g) => g.matcher ?? null;
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

export function parseSettingsText(text) {
  // Caller decides what a failure means; we never "repair" user JSON.
  return JSON.parse(text);
}

export function renderSettings(settings) {
  return `${JSON.stringify(settings, null, 2)}\n`;
}
