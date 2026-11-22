import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import type { Action, Answers, HouseConfig, SeedAction } from '@houserules/api';
import { MANIFEST_PATH } from '@houserules/api/internal';

import { apply } from '../apply.js';
import { detect, untrackFromIndex } from '../detect.js';
import type { Ctx } from '../detect.js';
import { HouseError } from '../house-error.js';
import { installedModuleIds } from '../installed-modules.js';
import { closeSelection } from '../module-requires.js';
import { ejectableDests } from '../modules/payload-gitignore.js';
import {
  MODULES,
  buildPlan,
  computeEffects,
  configOwnership,
} from '../plan.js';
import { selectFiles } from '../ui.js';
import { resolveRecordedModuleIds } from '../retired-modules.js';
import { buildRegistry } from '../plugin-resolver.js';

const CONFIG_DEST = '.claude/houserules.config.json';
const GITIGNORE_DEST = '.claude/.gitignore';
const SETTINGS_DEST = '.claude/settings.json';
const REGENERATED_DIRS = ['.claude/scripts/', '.claude/templates/'];

interface EjectOptions {
  /** Remove the entries instead of adding them. */
  shouldUndo: boolean;
  dryRun: boolean;
  /** Never open the picker: a directory or a bare run refuses and lists its files. */
  yes: boolean;
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** The repo-relative dest a path names, or null when it points outside the repo root. */
function destOf(root: string, path: string): string | null {
  const rel = toPosix(relative(root, resolve(root, path)));
  if (rel === '' || rel === '..' || rel.startsWith('../')) return null;
  return rel;
}

function isDirectory(root: string, dest: string): boolean {
  try {
    return statSync(resolve(root, dest)).isDirectory();
  } catch {
    return false;
  }
}

function gitQuiet(root: string, args: string[]): boolean {
  try {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function isInIndex(root: string, dest: string): boolean {
  return gitQuiet(root, ['ls-files', '--error-unmatch', '--', dest]);
}

function isInHead(root: string, dest: string): boolean {
  return gitQuiet(root, ['cat-file', '-e', `HEAD:${dest}`]);
}

/** Every whole file the plan writes under `.claude/`, whether or not the block lists it. */
function ownedDests(actions: Action[]): Set<string> {
  const owned = new Set<string>();
  for (const action of actions) {
    if (
      (action.kind === 'copy' ||
        action.kind === 'write' ||
        action.kind === 'body') &&
      action.dest.startsWith('.claude/')
    )
      owned.add(action.dest);
  }
  return owned;
}

function destsUnder(dests: Iterable<string>, dir: string | null): string[] {
  return [...dests]
    .filter((dest) => dir === null || dest.startsWith(`${dir}/`))
    .sort();
}

function listRefusal(head: string, candidates: string[]): string {
  return candidates.length
    ? `${head} Files:\n${candidates.map((dest) => `  ${dest}`).join('\n')}`
    : `${head} No file can be named here.`;
}

type Verdict = { dest: string } | { refusal: string };

interface Ownership {
  ctx: Ctx;
  config: HouseConfig;
  answers: Answers;
  registry: ReturnType<typeof buildRegistry>;
  owned: Set<string>;
  ejectable: Set<string>;
  ejected: Set<string>;
}

function judgeEject(
  root: string,
  path: string,
  { ctx, owned, ejectable, ejected }: Ownership,
): Verdict {
  const dest = destOf(root, path);
  if (dest === null || (!owned.has(dest) && !ejected.has(dest))) {
    if (dest === MANIFEST_PATH)
      return {
        refusal: `${path}: the manifest is a local receipt houserules rewrites on every run, so it cannot be ejected.`,
      };
    if (dest === SETTINGS_DEST)
      return {
        refusal: `${path}: git already tracks .claude/settings.json. houserules merges into it and never ignores it.`,
      };
    return {
      refusal: `${path}: houserules does not own this path, so there is nothing to eject.`,
    };
  }
  if (REGENERATED_DIRS.some((dir) => dest.startsWith(dir)))
    return {
      refusal: `${path}: houserules rewrites everything under .claude/scripts/ and .claude/templates/ on every sync, so an ejected copy would be overwritten.`,
    };
  if (ejected.has(dest)) return { dest };
  if (ctx.claude.houseConfig?.payload?.commit === true)
    return {
      refusal: `${path}: payload.commit is true, so git already tracks every installed file.`,
    };
  if (!ejectable.has(dest))
    return {
      refusal: `${path}: houserules does not list this file in .claude/.gitignore, so there is nothing to eject.`,
    };
  if (isInIndex(root, dest))
    return {
      refusal: `${path}: git already tracks this file, and ignore rules do not apply to a tracked file.`,
    };
  return { dest };
}

function judgeUndo(root: string, path: string, ejected: Set<string>): Verdict {
  const dest = destOf(root, path);
  if (dest === null || !ejected.has(dest))
    return { refusal: `${path}: this file is not ejected.` };
  return { dest };
}

/** The dests a picker or a directory refusal offers: what `eject` accepts one by one. */
function candidatesUnder(
  root: string,
  dir: string | null,
  shouldUndo: boolean,
  ownership: Ownership,
): string[] {
  if (shouldUndo) return destsUnder(ownership.ejected, dir);
  return destsUnder(ownership.ejectable, dir).filter(
    (dest) =>
      !ownership.ejected.has(dest) &&
      'dest' in judgeEject(root, dest, ownership),
  );
}

function shellWord(path: string): string {
  return /^[\w./@+=-]+$/.test(path)
    ? path
    : `'${path.replaceAll("'", `'\\''`)}'`;
}

function planOwnership(root: string, ctx: Ctx, config: HouseConfig): Ownership {
  const registry = buildRegistry(root, config, MODULES);
  const recorded = installedModuleIds(config, ctx.claude.manifest) ?? ['core'];
  const closed = closeSelection(
    registry,
    resolveRecordedModuleIds(recorded, registry),
    {
      persisted: config.moduleOptions,
      chosen: {},
      packageManager: ctx.packageManager?.name,
    },
  );
  const answers: Answers = {
    moduleIds: closed.closure.moduleIds,
    targets: config.targets?.length ? config.targets : ctx.targets,
    seedChangesetConfig: false,
    moduleOptions: closed.moduleOptions,
  };
  const actions = buildPlan(ctx, answers, registry);
  return {
    ctx,
    config,
    answers,
    registry,
    owned: ownedDests(actions),
    ejectable: ejectableDests(ctx, actions),
    ejected: new Set(config.ejected ?? []),
  };
}

interface Selection {
  dests: string[];
  refusals: string[];
  /** A directory, or a bare run, to pick from once no path has been refused. */
  pickers: { head: string; candidates: string[] }[];
}

/** Judges every path. A directory or a bare run becomes a picker, or a refusal under `yes`. */
function selectPaths(
  root: string,
  paths: string[],
  { shouldUndo, yes }: EjectOptions,
  ownership: Ownership,
): Selection {
  const selection: Selection = { dests: [], refusals: [], pickers: [] };
  const verb = shouldUndo ? 'return' : 'eject';
  const addDirectory = (head: string, dir: string | null): void => {
    const candidates = candidatesUnder(root, dir, shouldUndo, ownership);
    if (yes || !candidates.length)
      selection.refusals.push(listRefusal(head, candidates));
    else selection.pickers.push({ head: `Files to ${verb}`, candidates });
  };

  if (!paths.length) {
    addDirectory(`Name a file to ${verb}.`, null);
    return selection;
  }
  for (const path of paths) {
    const dest = destOf(root, path);
    const isOwnedFile =
      dest !== null &&
      (ownership.owned.has(dest) || ownership.ejected.has(dest));
    if (dest !== null && !isOwnedFile && isDirectory(root, dest)) {
      addDirectory(`${path} is a directory. Name a file instead.`, dest);
      continue;
    }
    const verdict = shouldUndo
      ? judgeUndo(root, path, ownership.ejected)
      : judgeEject(root, path, ownership);
    if ('refusal' in verdict) selection.refusals.push(verdict.refusal);
    else if (!selection.dests.includes(verdict.dest))
      selection.dests.push(verdict.dest);
  }
  return selection;
}

function nextEjected(
  ejected: Set<string>,
  dests: string[],
  shouldUndo: boolean,
): string[] {
  return shouldUndo
    ? [...ejected].filter((dest) => !dests.includes(dest))
    : [...new Set([...ejected, ...dests])];
}

/**
 * Writes the config's `ejected` list and the rewritten block through `apply()`. An existing
 * manifest keeps its own install record, so only the block's recorded hash moves. Advancing
 * `kitVersion` here would mark a stale install current and the SessionStart sync would never
 * refresh it. With no manifest none is written, so a fresh clone's first sync still sees it
 * missing.
 */
function writeEjected(
  root: string,
  ownership: Ownership,
  next: string[],
  kitVersion: string,
): void {
  const { ctx, config, answers, registry } = ownership;
  const { ejected: _previous, ...rest } = config;
  const nextConfig = next.length ? { ...rest, ejected: next } : rest;
  const nextCtx: Ctx = {
    ...ctx,
    claude: { ...ctx.claude, houseConfig: nextConfig },
  };
  // buildPlan appends the block last, from the config's `ejected` list, so planning against
  // the next config yields the rewritten block.
  const blockActions = buildPlan(nextCtx, answers, registry).filter(
    (action) => action.kind === 'region' && action.dest === GITIGNORE_DEST,
  );
  const seed: SeedAction = {
    kind: 'seed',
    dest: CONFIG_DEST,
    content: `${JSON.stringify(next.length ? { ejected: next } : {})}\n`,
    managedKeys: ['ejected'],
    module: 'core',
    reason: 'records which installed files the team owns',
  };
  const planResult = computeEffects(root, [seed, ...blockActions], {
    manifest: ctx.claude.manifest,
    force: true,
    plugins: registry.plugins,
    ...configOwnership(nextConfig),
  });
  const manifest = ctx.claude.manifest;
  apply(root, planResult, {
    kitVersion: manifest?.kitVersion ?? kitVersion,
    moduleIds: manifest?.modules ?? answers.moduleIds,
    previousManifest: manifest,
    plugins: manifest
      ? (manifest.plugins ?? []).map((plugin) => ({ ...plugin, dir: '' }))
      : registry.plugins,
    recordsManifest: manifest !== null,
  });
}

function printEjectReport(dests: string[]): void {
  const pronoun = dests.length === 1 ? 'it' : 'them';
  const files = [...dests, CONFIG_DEST, GITIGNORE_DEST]
    .map(shellWord)
    .join(' ');
  console.log(
    `Ejected ${dests.join(', ')}. houserules now leaves ${pronoun} alone.`,
  );
  console.log(`Share ${pronoun} with: git add ${files}`);
}

function printUndoReport(
  root: string,
  dests: string[],
  tracked: string[],
): void {
  for (const dest of dests) {
    if (!tracked.includes(dest) || !isInHead(root, dest))
      console.log(`${dest} is ignored again.`);
  }
  if (tracked.some((dest) => isInHead(root, dest)))
    console.log('Commit the staged removal to finish.');
}

function readOwnership(root: string): Ownership | number {
  const ctx = detect(root);
  const config = ctx.claude.houseConfig;
  if (!config) {
    console.error(
      'No readable .claude/houserules.config.json. Run: npx houserules init',
    );
    return 1;
  }
  try {
    return planOwnership(root, ctx, config);
  } catch (error) {
    if (error instanceof HouseError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

/**
 * `houserules eject [path...]`: takes ownership of installed files so a team can commit and
 * share a customized copy, and `--undo` hands them back. A directory, or no path, opens a
 * picker over the files eject accepts there, and `yes` refuses and lists them instead.
 *
 * Every path is validated, every pick made, and every write prepared before anything changes,
 * so a refused path leaves the config, the `.claude/.gitignore` block, and the git index as
 * they were. The only index write is `--undo` untracking a dest git tracks, staged and never
 * committed.
 *
 * @returns The exit code.
 */
export async function eject(
  dir: string,
  paths: string[],
  options: EjectOptions,
  kitVersion: string,
): Promise<number> {
  const root = resolve(dir);
  const { shouldUndo, dryRun } = options;
  const ownership = readOwnership(root);
  if (typeof ownership === 'number') return ownership;

  const selection = selectPaths(root, paths, options, ownership);
  if (selection.refusals.length) {
    for (const refusal of selection.refusals) console.error(refusal);
    console.error('Nothing changed.');
    return 1;
  }
  const dests = [...selection.dests];
  for (const { head, candidates } of selection.pickers) {
    for (const dest of await selectFiles(candidates, head)) {
      if (!dests.includes(dest)) dests.push(dest);
    }
  }

  const { ejected } = ownership;
  const next = nextEjected(ejected, dests, shouldUndo);
  if (next.length === ejected.size && next.every((dest) => ejected.has(dest))) {
    console.log(
      shouldUndo
        ? 'Nothing to undo. None of those files is ejected.'
        : 'Already ejected. Nothing changed.',
    );
    return 0;
  }
  if (dryRun) {
    console.log(
      `Dry run. Would ${shouldUndo ? 'return' : 'eject'}: ${dests.join(', ')}`,
    );
    return 0;
  }

  // Staged before anything is written, so a refusal from git leaves the tree untouched.
  const tracked = shouldUndo
    ? dests.filter((dest) => isInIndex(root, dest))
    : [];
  if (tracked.length && !untrackFromIndex(root, tracked)) {
    console.error(
      `git refused to untrack ${tracked.join(', ')}. Nothing changed.`,
    );
    return 1;
  }
  writeEjected(root, ownership, next, kitVersion);

  if (shouldUndo) printUndoReport(root, dests, tracked);
  else printEjectReport(dests);
  return 0;
}
