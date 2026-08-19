import { HouseError } from './house-error.js';
import type { Registry } from './plugin-registry.js';

/**
 * Parses repeated `--module-option <id>=<v1,v2>` flags into the `overrides` shape
 * `resolveModuleOptions` expects.
 *
 * Splits each value on the first `=` only, so a plugin-namespaced id such as
 * `voice/prose-voice` survives. Whitespace around the id and around each value is
 * trimmed, and empty entries from a trailing comma are dropped.
 *
 * @throws HouseError when a value has no `=`, an empty id, an empty value list, or an id
 *   repeated across two flags.
 */
export function parseModuleOptionFlags(
  values: string[],
): Record<string, string[]> {
  const overrides: Record<string, string[]> = {};
  for (const raw of values) {
    const eqIndex = raw.indexOf('=');
    if (eqIndex === -1) {
      throw new HouseError(
        `Invalid --module-option "${raw}". Expected the form id=value1,value2.`,
      );
    }
    const id = raw.slice(0, eqIndex).trim();
    const list = raw
      .slice(eqIndex + 1)
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (!id || list.length === 0) {
      throw new HouseError(
        `Invalid --module-option "${raw}". Expected the form id=value1,value2.`,
      );
    }
    if (id in overrides) {
      throw new HouseError(`--module-option "${id}" was given more than once.`);
    }
    overrides[id] = list;
  }
  return overrides;
}

/**
 * Refuses to plan while an enabled module's option selection is UNRECORDED.
 *
 * The failure this exists for is the upgrade path. An install made before selections were
 * persisted has the files a real selection produced sitting on disk and in the manifest, and
 * nothing in `houserules.config.json` saying which selection that was. `resolveModuleOptions` then
 * falls back to the module's `defaults`, the plan stops producing every non-default file, and
 * `computePrune` retires them under the heading "retired by houserules version". That heading is
 * false and the deletion is silent, which is the whole class of bug this guard closes.
 *
 * Deliberately NOT "never prune an options-derived file". A `--reconfigure` that drops a value
 * is a real withdrawal and has to prune. The two are told apart by whether a selection is
 * recorded at all, which is knowable here, before any plan exists.
 *
 * @param overrides Selections named on the command line this run, which count as recorded.
 * @throws HouseError naming each module and the command that settles it. Callers that mean to
 *   accept the defaults pass `--force`, which skips this entirely.
 */
export function assertOptionsRecorded(
  registry: Registry,
  moduleIds: string[],
  persisted: Record<string, string[]> | undefined,
  overrides: Record<string, string[]> = {},
): void {
  const unrecorded = moduleIds.filter(
    (id) =>
      registry.get(id)?.def.options &&
      !(id in (persisted ?? {})) &&
      !(id in overrides),
  );
  if (!unrecorded.length) return;

  const fixes = unrecorded
    .map((id) => {
      const values = registry.get(id)?.def.options?.defaults ?? [];
      // A module with empty `defaults` has nothing to put after the `=`, and an empty value
      // list is the one thing parseModuleOptionFlags refuses. Bare --reconfigure prompts.
      return values.length
        ? `  npx houserules modules --reconfigure=${id} --module-option ${id}=${values.join(',')}`
        : `  npx houserules modules --reconfigure=${id}`;
    })
    .join('\n');
  throw new HouseError(
    `No recorded option selection for: ${unrecorded.join(', ')}.\n` +
      'Planning would fall back to each module’s defaults and retire the files any other ' +
      'selection installed, which reads as a deliberate removal but is not one.\n' +
      `Record the selection you actually want, for example:\n${fixes}\n` +
      'Re-run with --force to accept the defaults and let the prune proceed.',
  );
}

/**
 * Settles each enabled module's option selections without asking anything.
 *
 * This is the path `update`, `doctor`, and any `--yes` run take, so it has to be total: every
 * enabled module that declares options ends up with a value. A persisted selection wins, and a
 * module with nothing persisted falls back to its declared `defaults`. Without that fallback a
 * non-interactive install of an option-bearing module would be undefined.
 *
 * Persisted values not in the module's `choices` are dropped rather than passed through. A
 * stale entry is what you get when a plugin retires a choice, and planning against a value the
 * module no longer understands would produce actions pointing at payload files that are gone.
 *
 * Precedence is explicit beats persisted beats default. An `--module-option` on the command
 * line is the user speaking now, so it outranks what a previous run wrote to config.
 *
 * @param persisted `moduleOptions` from `.claude/houserules.config.json`, or undefined on a repo that
 *   has no config yet.
 * @param overrides Selections named on the command line this run.
 */
export function resolveModuleOptions(
  registry: Registry,
  moduleIds: string[],
  persisted: Record<string, string[]> | undefined,
  overrides: Record<string, string[]> = {},
): Record<string, string[]> {
  const resolved: Record<string, string[]> = {};
  for (const id of moduleIds) {
    const options = registry.get(id)?.def.options;
    if (!options) continue;
    const valid = new Set(options.choices.map((choice) => choice.value));
    const chosen = overrides[id] ?? persisted?.[id];
    resolved[id] = chosen
      ? chosen.filter((value) => valid.has(value))
      : [...options.defaults];
  }
  return resolved;
}
