import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { MANIFEST_PATH } from '@houserules/api/internal';

import { trackedAmong } from '../detect.js';
import type { Ctx } from '../detect.js';
import type { MigrationClassification } from './migration-classify.js';

type MigrationFindingKind =
  'mass-misread' | 'manifest-disagrees' | 'staged-or-unmerged';

/**
 * How the user answers a finding. `force` is today's `--force`, `eject-all` keeps every
 * edited file as the team's own, and `stop` changes nothing and exits 1.
 */
export type MigrationChoice = 'force' | 'eject-all' | 'stop';

interface MigrationOption {
  choice: MigrationChoice;
  /** One line saying what the choice does to which files. */
  label: string;
  /** The flag that picks this option with no terminal, or null for `stop`. */
  flag: '--force' | '--eject-all' | null;
}

/** One reason the migration will not proceed on its own. */
export interface MigrationFinding {
  kind: MigrationFindingKind;
  /** What was found, naming the counts. */
  message: string;
  /** The dests the finding is about, sorted. */
  paths: string[];
  /**
   * The answers on offer, `stop` first, since it is the default. `staged-or-unmerged` offers
   * `stop` alone.
   */
  options: MigrationOption[];
}

const STOP_LABEL =
  'Stop. Changes nothing, so you can run `npx houserules doctor` and read the diffs.';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function stopOption(): MigrationOption {
  return { choice: 'stop', label: STOP_LABEL, flag: null };
}

function overrideOptions(editedCount: number): MigrationOption[] {
  const files = plural(editedCount, 'edited file');
  return [
    stopOption(),
    {
      choice: 'force',
      label: `Overwrite your edits to the ${files} with houserules' copies.`,
      flag: '--force',
    },
    {
      choice: 'eject-all',
      label: `Keep the ${files} as yours by ejecting them.`,
      flag: '--eject-all',
    },
  ];
}

function gitLines(root: string, args: string[]): string[] {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The members of `paths` git ignores, in one `git check-ignore --stdin` call run from `root`
 * with cwd-relative paths. Empty when none is ignored, or on any git failure.
 */
function ignoredAmong(root: string, paths: readonly string[]): Set<string> {
  if (!paths.length) return new Set();
  let out: string;
  try {
    out = execFileSync('git', ['check-ignore', '--stdin'], {
      cwd: root,
      encoding: 'utf8',
      input: `${paths.join('\n')}\n`,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch (error) {
    // check-ignore exits 1 when it ignores none of the paths, which is an answer, not a failure.
    out = String((error as { stdout?: unknown }).stdout ?? '');
  }
  return new Set(out.split('\n').filter(Boolean));
}

// Strictly more than this share of the classified set reading as edited raises mass misread.
const MASS_MISREAD_SHARE = 0.5;

function massMisread(
  classification: MigrationClassification,
): MigrationFinding | null {
  const { classified, edited } = classification;
  if (edited.length <= classified.length * MASS_MISREAD_SHARE) return null;
  return {
    kind: 'mass-misread',
    message: `${edited.length} of ${plural(classified.length, 'committed payload file')} read as edited, more than half. That usually means the comparison misread the files, not that you edited them.`,
    paths: [...edited].sort(),
    options: overrideOptions(edited.length),
  };
}

function manifestDisagrees(
  root: string,
  ctx: Ctx,
  classification: MigrationClassification,
): MigrationFinding | null {
  const manifest = ctx.claude.manifest;
  if (!manifest) return null;
  if (!trackedAmong(root, [MANIFEST_PATH]).length) return null;

  // A fresh clone never has the files git ignores, so only a missing dest git would carry counts.
  const absent = Object.keys(manifest.files).filter(
    (dest) => !existsSync(join(root, dest)),
  );
  const ignored = ignoredAmong(root, absent);
  const missing = absent.filter((dest) => !ignored.has(dest)).sort();
  const configModules = ctx.claude.houseConfig?.modules;
  const modulesDiffer =
    configModules !== undefined &&
    [...new Set(configModules)].sort().join('\n') !==
      [...new Set(manifest.modules)].sort().join('\n');
  if (!missing.length && !modulesDiffer) return null;

  const reasons: string[] = [];
  if (missing.length) {
    reasons.push(
      `${plural(missing.length, 'file')} the manifest lists ${missing.length === 1 ? 'is' : 'are'} missing from disk and not ignored by git`,
    );
  }
  if (modulesDiffer) {
    reasons.push("the config's modules differ from the manifest's modules");
  }
  return {
    kind: 'manifest-disagrees',
    message: `The committed manifest disagrees with the tree: ${reasons.join(', and ')}.`,
    paths: missing,
    options: overrideOptions(classification.edited.length),
  };
}

function stagedOrUnmerged(
  root: string,
  classification: MigrationClassification,
): MigrationFinding | null {
  const pathspec = ['--', ...classification.classified, MANIFEST_PATH];
  const staged = gitLines(root, [
    'diff',
    '--cached',
    '--relative',
    '--name-only',
    ...pathspec,
  ]);
  const unmerged = gitLines(root, ['ls-files', '-u', ...pathspec]).map((line) =>
    line.slice(line.indexOf('\t') + 1),
  );
  const paths = [...new Set([...staged, ...unmerged])].sort();
  if (!paths.length) return null;
  return {
    kind: 'staged-or-unmerged',
    message: `${plural(paths.length, 'payload path')} ${paths.length === 1 ? 'has' : 'have'} staged changes or unmerged entries. Finish or unstage them first.`,
    paths,
    options: [stopOption()],
  };
}

/**
 * The pre-verify pass: each finding is its own function of the repo state returning one
 * finding or null, and this keeps the non-null results in a fixed order (mass misread,
 * manifest disagrees, staged or unmerged). Reads everything and writes nothing, neither the
 * config nor the index.
 */
export function preverifyMigration(
  root: string,
  ctx: Ctx,
  classification: MigrationClassification,
): MigrationFinding[] {
  return [
    massMisread(classification),
    manifestDisagrees(root, ctx, classification),
    stagedOrUnmerged(root, classification),
  ].filter((finding): finding is MigrationFinding => finding !== null);
}

/**
 * The lines `update` prints when a finding stops a run with no terminal: the finding, then
 * each option with the flag that picks it.
 */
export function noTerminalReport(
  findings: readonly MigrationFinding[],
): string {
  const lines: string[] = [];
  for (const finding of findings) {
    lines.push(finding.message);
    for (const option of finding.options) {
      lines.push(
        `  ${option.flag ?? 'no flag (the default)'}: ${option.label}`,
      );
    }
  }
  lines.push('No terminal to ask on, so nothing was written.');
  return lines.join('\n');
}
