import type { Action } from '@houserules/api';
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

/** The keep and discard lines for each edited path that is ignored and not ejected. */
export function localEditHints(
  paths: readonly string[],
  ignored: ReadonlySet<string>,
  commandPrefix: string,
): string[] {
  return paths
    .filter((path) => ignored.has(path))
    .flatMap((path) => [
      `${path}: to keep your edit, run \`${commandPrefix} eject ${path}\``,
      `${path}: to discard your edit, delete the file and run \`${commandPrefix} update\`, which recreates it`,
    ]);
}
