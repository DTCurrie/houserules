import { dirname } from 'node:path';

import type {
  Action,
  BodyAction,
  CopyAction,
  RegionSpec,
  WriteAction,
} from '@houserules/api';
import type { Ctx } from '../detect.js';

/**
 * houserules' managed block in `.claude/.gitignore`. Exported so the tests find the block by the
 * same markers the plan writes, since a marker string defined in two places is how a managed
 * region silently stops being found.
 */
export const PAYLOAD_GITIGNORE_REGION: RegionSpec = {
  id: 'gitignore',
  start: '# houserules:gitignore start',
  end: '# houserules:gitignore end',
  anchor: 'eof',
};

const PAYLOAD_GITIGNORE_DEST = '.claude/.gitignore';

// Whole files houserules writes from the payload. `seed` is user-owned once written, and
// `region`/`merge-settings` sit inside files the user owns, so none of those are ignorable.
function isListedKind(
  action: Action,
): action is CopyAction | WriteAction | BodyAction {
  return (
    action.kind === 'copy' || action.kind === 'write' || action.kind === 'body'
  );
}

// Written by apply, never by an action, so no plan derives it.
const KIT_MANIFEST = '.claude/houserules.manifest.json';

const SCRIPTS_DIR = '.claude/scripts';

/**
 * The directories this plan already self-gitignores with a `*` line, read from its own
 * `<dir>/.gitignore` writes rather than a list, so a module that adds one is honored the day
 * it lands. Listing a dest under one of them again would only repeat what git already does.
 */
export function selfIgnoredDirs(actions: readonly Action[]): string[] {
  return actions
    .filter(
      (action): action is WriteAction =>
        action.kind === 'write' &&
        action.dest.endsWith('/.gitignore') &&
        action.content.split('\n').some((line) => line.trim() === '*'),
    )
    .map((action) => dirname(action.dest));
}

function isUnder(dest: string, dir: string): boolean {
  return dest.startsWith(`${dir}/`);
}

const GITIGNORE_GLOB_METACHARACTERS = /[\\*?[]/g;
// git strips an unescaped trailing space from a pattern line.
const TRAILING_SPACE = / $/;

// A gitignore line is a glob. Escaping the metacharacters keeps each line matching exactly
// the one path it names, whatever characters a plugin's file happens to carry.
function gitignoreLiteral(path: string): string {
  return path
    .replace(GITIGNORE_GLOB_METACHARACTERS, '\\$&')
    .replace(TRAILING_SPACE, '\\ ');
}

/**
 * The repo-relative dests the block would list before any eject, the manifest aside: every
 * whole file the plan writes under `.claude/` that no self-gitignored directory already
 * covers. This is the set `eject` accepts, read from the config's modules rather than the
 * manifest, which a fresh clone lacks. Empty under `payload.commit: true`, where no block is
 * written and every payload file is already tracked.
 */
export function ejectableDests(ctx: Ctx, actions: Action[]): Set<string> {
  const dests = new Set<string>();
  if (ctx.claude.houseConfig?.payload?.commit === true) return dests;

  const skipDirs = selfIgnoredDirs(actions);
  if (ctx.claude.houseConfig?.scripts?.commit === true)
    skipDirs.push(SCRIPTS_DIR);

  for (const action of actions) {
    if (!isListedKind(action)) continue;
    const { dest } = action;
    if (!dest.startsWith('.claude/')) continue;
    if (dest === PAYLOAD_GITIGNORE_DEST) continue;
    if (skipDirs.some((dir) => isUnder(dest, dir))) continue;
    dests.add(dest);
  }
  return dests;
}

/**
 * The `.claude/` paths the block lists, relative to `.claude/` with a leading `/` so each
 * line is anchored to one file, sorted and deduplicated. An ejected dest is left out, so git
 * sees it as untracked and the team can commit it.
 */
function ignoredPaths(ctx: Ctx, actions: Action[]): string[] {
  const ejected = new Set(ctx.claude.houseConfig?.ejected ?? []);
  const dests = [KIT_MANIFEST, ...ejectableDests(ctx, actions)].filter(
    (dest) => !ejected.has(dest),
  );

  return dests
    .map((dest) => `/${gitignoreLiteral(dest.slice('.claude/'.length))}`)
    .sort();
}

/**
 * Keeps the installed payload out of git: one managed block in `.claude/.gitignore` naming each
 * file the plan writes under `.claude/`, by path, so a user's own skill or agent beside the
 * kit's stays tracked. The payload is rebuilt from `houserules.config.json` by `update`.
 *
 * `actions` must be every enabled module's actions, for the same reason as the prettier
 * guard: a plugin's dests enter the block only if the caller has already collected them.
 *
 * With `payload.commit: true` the block is not written, and the payload is committed as before.
 */
export function payloadGitignoreActions(ctx: Ctx, actions: Action[]): Action[] {
  if (ctx.claude.houseConfig?.payload?.commit === true) return [];

  return [
    {
      kind: 'region',
      dest: PAYLOAD_GITIGNORE_DEST,
      body: [
        '# Installed by houserules and rebuilt by `npx houserules update`.',
        ...ignoredPaths(ctx, actions),
      ].join('\n'),
      region: PAYLOAD_GITIGNORE_REGION,
      module: 'core',
      reason:
        'keeps the installed payload out of git, by path, so your own files beside it stay tracked (content outside the markers is never touched)',
    },
  ];
}
