import type { Action } from '@houserules/api';
import { trackedAmong } from '../detect.js';
import type { Ctx } from '../detect.js';
import { ejectableDests } from '../modules/payload-gitignore.js';

/**
 * The dests a local edit can be ejected from: owned by the plan, listed in the ignore block,
 * and not yet ejected. A committed file is never in the set, so it gets no eject line.
 */
export function ignoredUnejectedDests(
  ctx: Ctx,
  effects: readonly { action: Action }[],
  ejected: ReadonlySet<string>,
): Set<string> {
  const dests = ejectableDests(
    ctx,
    effects.map((effect) => effect.action),
  );
  for (const dest of ejected) dests.delete(dest);
  return dests;
}

// Regenerated on every sync and migrated by their own untrack, so never classified.
const UNCLASSIFIED_DIRS = ['.claude/scripts/', '.claude/templates/'];

/**
 * The payload migration's classified set: the dests {@link ignoredUnejectedDests} returns that
 * git still tracks, sorted. Empty under `payload.commit: true` and outside a git work tree.
 */
export function classifiedDests(
  root: string,
  ctx: Ctx,
  effects: readonly { action: Action }[],
  ejected: ReadonlySet<string>,
): string[] {
  if (!ctx.git.isRepo) return [];
  const candidates = [...ignoredUnejectedDests(ctx, effects, ejected)].filter(
    (dest) => !UNCLASSIFIED_DIRS.some((dir) => dest.startsWith(dir)),
  );
  return trackedAmong(root, candidates).sort();
}

/**
 * The keep and discard lines for each edited path that is ignored and not ejected.
 *
 * @param tracked Dests git still tracks. `eject` refuses those, so they get the discard line only.
 */
export function localEditHints(
  paths: readonly string[],
  ignored: ReadonlySet<string>,
  commandPrefix: string,
  tracked: ReadonlySet<string> = new Set(),
): string[] {
  return paths
    .filter((path) => ignored.has(path))
    .flatMap((path) => [
      ...(tracked.has(path)
        ? []
        : [
            `${path}: to keep your edit, run \`${commandPrefix} eject ${path}\``,
          ]),
      `${path}: to discard your edit, delete the file and run \`${commandPrefix} update\`, which recreates it`,
    ]);
}
