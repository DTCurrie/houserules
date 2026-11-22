import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BodyAction } from '@houserules/api';

import type { Ctx } from '../detect.js';
import { configOwnership } from '../plan.js';
import type { PlanResult } from '../plan.js';
import { computeDrift } from './drift.js';
import {
  parseFrontmatterPaths,
  renderFrontmatterPaths,
  splitFrontmatter,
} from './frontmatter.js';
import { classifiedDests } from './local-edit-hints.js';

const RULE_DEST = /^\.claude\/rules\/(.+)\.md$/;

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** How a classified rule's disk frontmatter stands against the one houserules ships. */
type RuleFrontmatter =
  | { kind: 'unedited' }
  | { kind: 'paths-only'; ruleId: string; paths: string[] }
  | { kind: 'other' };

function judgeRuleFrontmatter(
  root: string,
  action: BodyAction,
  rulePaths: Readonly<Record<string, readonly string[]>>,
): RuleFrontmatter {
  const source = readOrNull(action.src);
  const disk = readOrNull(join(root, action.dest));
  // A missing payload file or a deleted dest is drift's to report, not a frontmatter edit.
  if (source === null || disk === null) return { kind: 'unedited' };
  const ruleId = RULE_DEST.exec(action.dest)?.[1];
  const configPaths =
    ruleId !== undefined && Object.hasOwn(rulePaths, ruleId)
      ? rulePaths[ruleId]
      : undefined;
  const rawShipped = splitFrontmatter(source).frontmatter;
  const shipped =
    configPaths === undefined
      ? rawShipped
      : renderFrontmatterPaths(rawShipped, configPaths);
  const diskFrontmatter = splitFrontmatter(disk).frontmatter;
  if (diskFrontmatter === shipped) return { kind: 'unedited' };
  if (ruleId === undefined) return { kind: 'other' };
  const diskPaths = parseFrontmatterPaths(diskFrontmatter);
  if (
    diskPaths !== null &&
    renderFrontmatterPaths(shipped, diskPaths) === diskFrontmatter
  ) {
    return { kind: 'paths-only', ruleId, paths: diskPaths };
  }
  return { kind: 'other' };
}

/** What the payload migration found in an install that committed its payload. */
export interface MigrationClassification {
  /**
   * The classified set, from `classifiedDests` in `local-edit-hints.ts`: the tracked dests
   * among the ignored, unejected ones. Sorted.
   */
  classified: string[];
  /**
   * The classified dests read as edited, sorted. A file drift reads `yours` or `conflict`, or
   * a rule whose frontmatter differs from the shipped one byte for byte. A subset of
   * `classified`.
   */
  edited: string[];
  /**
   * The edited dests the migration ejects: every edited dest except a rule whose only edit is
   * a trimmed `paths:`. Sorted. A subset of `edited`.
   */
  toEject: string[];
  /**
   * Rule id, as `configOwnership` keys it, to the `paths:` read from disk, for each rule
   * whose only edit is a trimmed `paths:`. Each such rule is in `edited` and not in `toEject`.
   */
  rulePaths: Record<string, string[]>;
}

/**
 * Classifies a committed install for the payload migration. Reads the tree and the index and
 * writes nothing.
 *
 * @param planResult A plan computed with `force: false` against `ctx`, so a local edit reads
 *   `skip-modified`. A forced plan reads every edit as an update and classifies nothing.
 */
export function classifyMigration(
  root: string,
  ctx: Ctx,
  planResult: PlanResult,
): MigrationClassification {
  const ownership = configOwnership(ctx.claude.houseConfig);
  const classified = classifiedDests(
    root,
    ctx,
    planResult.effects,
    ownership.ejected,
  );
  const inClassified = new Set(classified);
  const bodyEdited = new Set(
    computeDrift(root, planResult.effects, { manifest: ctx.claude.manifest })
      .files.filter(
        (file) => file.status === 'yours' || file.status === 'conflict',
      )
      .map((file) => file.path)
      .filter((path) => inClassified.has(path)),
  );
  const edited = new Set(bodyEdited);
  const toEject = new Set(bodyEdited);
  const rulePaths: Record<string, string[]> = {};
  for (const { action } of planResult.effects) {
    if (action.kind !== 'body') continue;
    if (!action.dest.startsWith('.claude/rules/')) continue;
    if (!inClassified.has(action.dest) || bodyEdited.has(action.dest)) continue;
    const judged = judgeRuleFrontmatter(root, action, ownership.rulePaths);
    if (judged.kind === 'unedited') continue;
    edited.add(action.dest);
    if (judged.kind === 'paths-only') {
      rulePaths[judged.ruleId] = judged.paths;
    } else {
      toEject.add(action.dest);
    }
  }
  return {
    classified,
    edited: [...edited].sort(),
    toEject: [...toEject].sort(),
    rulePaths,
  };
}
