import { join } from 'node:path';

import { computeFriction, type FrictionReport } from './friction.js';
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
import type { Corpus, FileUsage } from './transcript-events.js';

const LEDGERS: [skill: string, ledgerFile: string][] = [
  ['backlog-add', 'backlog.jsonl'],
  ['decide', 'decisions.jsonl'],
];

/**
 * Where a report came from. Carries no path and no hostname by construction, so an export
 * built from a work machine can be read anywhere.
 */
export interface ReportMeta {
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

/** {@link FileUsage} with its model set as an array, so it survives JSON. */
export interface SerializedFileUsage extends Omit<FileUsage, 'models'> {
  models: string[];
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
}

export interface BuildOptions {
  label: string;
  cliVersion: string;
  since?: string;
  now?: Date;
}

export function serializeTokenUsage(
  report: TokenUsageReport,
): SerializedTokenUsage {
  return {
    ...report,
    files: report.files.map((file) => ({
      ...file,
      models: [...file.models].sort(),
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
    })),
  };
}

function isoDay(ts: number | undefined): string | undefined {
  return ts === undefined ? undefined : new Date(ts).toISOString().slice(0, 10);
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
      from: isoDay(corpus.firstTs),
      to: isoDay(corpus.lastTs),
      since: options.since,
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
    friction: computeFriction(corpus),
    residentContext: computeResidentContext(corpus),
  };
}
