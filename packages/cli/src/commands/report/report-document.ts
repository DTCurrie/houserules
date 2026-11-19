import { join } from 'node:path';

import {
  computeArtifactEpisodes,
  type ArtifactReport,
} from './artifact-episodes.js';
import {
  computeFriction,
  readTrimInstalled,
  type FrictionReport,
} from './friction.js';
import { computeGuardBlocks, type GuardBlock } from './guard-efficacy.js';
import { computeHookHealth, type HookHealthReport } from './hook-health.js';
import {
  computeResidentContext,
  type ResidentContextReport,
} from './resident-context.js';
import {
  computeSkillAdoption,
  type SkillAdoptionReport,
} from './skill-adoption.js';
import {
  computeChangesetOutcome,
  computeLedgerOutcome,
  type ChangesetOutcome,
  type LedgerOutcome,
} from './skill-outcomes.js';
import { computeTokenUsage, type TokenUsageReport } from './token-usage.js';
import type { Corpus, FileUsage, UsageSlice } from './transcript-events.js';

const LEDGERS: [skill: string, ledgerFile: string][] = [
  ['backlog-add', 'backlog.jsonl'],
  ['decide', 'decisions.jsonl'],
];

/**
 * Where a report came from. Carries no path and no hostname by construction, so an export
 * built from a work machine can be read anywhere.
 */
interface ReportMeta {
  /** The name the user gave the machine or corpus, e.g. "home" or "work". */
  label: string;
  cliVersion: string;
  claudeVersions: string[];
  sessions: number;
  /** YYYY-MM-DD of the earliest and latest timestamped record, absent when none carried one. */
  from?: string;
  to?: string;
  /** The `--since` day the corpus was filtered to, when one was given. */
  since?: string;
  /** ISO timestamp of the build. */
  generatedAt: string;
}

/** {@link FileUsage} with its model set as an array and its per-model map as a record, so it survives JSON. */
interface SerializedFileUsage extends Omit<FileUsage, 'models' | 'byModel'> {
  models: string[];
  byModel: Record<string, UsageSlice>;
}

export interface SerializedTokenUsage extends Omit<TokenUsageReport, 'files'> {
  files: SerializedFileUsage[];
}

/**
 * Every section `houserules report` renders, as data. `--json` prints it, `--export` writes
 * it redacted, `--import` renders it back. Each section is the shape its compute function
 * returns, except tokens, whose model sets are serialized.
 */
export interface ReportDocument {
  meta: ReportMeta;
  tokens: SerializedTokenUsage;
  hooks: HookHealthReport;
  guard: GuardBlock[];
  skills: SkillAdoptionReport;
  outcomes: { changesets: ChangesetOutcome; ledgers: LedgerOutcome[] };
  friction: FrictionReport;
  residentContext: ResidentContextReport;
  /** Absent in a document exported before the section existed, and rendered as absent, not zero. */
  artifacts?: ArtifactReport;
}

export interface BuildOptions {
  label: string;
  cliVersion: string;
  since?: string | undefined;
  now?: Date;
}

function serializeTokenUsage(report: TokenUsageReport): SerializedTokenUsage {
  return {
    ...report,
    files: report.files.map((file) => ({
      ...file,
      models: [...file.models].sort(),
      byModel: Object.fromEntries(
        [...file.byModel].sort(([leftModel], [rightModel]) =>
          leftModel < rightModel ? -1 : leftModel > rightModel ? 1 : 0,
        ),
      ),
    })),
  };
}

export function deserializeTokenUsage(
  tokens: SerializedTokenUsage,
): TokenUsageReport {
  return {
    ...tokens,
    files: tokens.files.map((file) => ({
      ...file,
      models: new Set(file.models),
      byModel: new Map(Object.entries(file.byModel)),
    })),
  };
}

function isoDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Stamps whether the install at `top` has the trim module onto the result-size readout. */
function withTrimInstalled(
  friction: FrictionReport,
  top: string,
): FrictionReport {
  if (!friction.toolResultSizes) return friction;
  const isTrimInstalled = readTrimInstalled(top);
  return {
    ...friction,
    toolResultSizes: {
      ...friction.toolResultSizes,
      ...(isTrimInstalled === undefined ? {} : { isTrimInstalled }),
    },
  };
}

/** Computes every section once over the corpus. `top` is the repo root the ledgers live in. */
export function buildReportDocument(
  corpus: Corpus,
  top: string,
  options: BuildOptions,
): ReportDocument {
  return {
    meta: {
      label: options.label,
      cliVersion: options.cliVersion,
      claudeVersions: [...corpus.claudeVersions].sort(),
      sessions: corpus.files.length,
      ...(corpus.firstTs === undefined ? {} : { from: isoDay(corpus.firstTs) }),
      ...(corpus.lastTs === undefined ? {} : { to: isoDay(corpus.lastTs) }),
      ...(options.since === undefined ? {} : { since: options.since }),
      generatedAt: (options.now ?? new Date()).toISOString(),
    },
    tokens: serializeTokenUsage(computeTokenUsage(corpus)),
    hooks: computeHookHealth(corpus),
    guard: computeGuardBlocks(corpus),
    skills: computeSkillAdoption(corpus, join(top, '.claude', 'skills')),
    outcomes: {
      changesets: computeChangesetOutcome(corpus, top),
      ledgers: LEDGERS.map(([skill, ledgerFile]) =>
        computeLedgerOutcome(corpus, top, ledgerFile, skill),
      ),
    },
    friction: withTrimInstalled(computeFriction(corpus), top),
    residentContext: computeResidentContext(corpus, top),
    artifacts: computeArtifactEpisodes(corpus),
  };
}
