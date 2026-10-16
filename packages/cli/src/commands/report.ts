import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { detect } from '../detect.js';
import type { Flags } from '../cli-contract.js';
import { HouseError } from '../house-error.js';
import { json } from './log.js';
import { renderFriction } from './report/friction.js';
import { renderGuardEfficacy } from './report/guard-efficacy.js';
import { renderHookHealth } from './report/hook-health.js';
import { renderComparison } from './report/render-compare.js';
import {
  buildReportDocument,
  deserializeTokenUsage,
  type ReportDocument,
} from './report/report-document.js';
import {
  readImportFiles,
  redactDocument,
  writeExportFile,
} from './report/report-export.js';
import { renderResidentContext } from './report/resident-context.js';
import { renderSkillAdoption } from './report/skill-adoption.js';
import { renderSkillOutcomes } from './report/skill-outcomes.js';
import { renderTokenUsage } from './report/token-usage.js';
import { readCorpus } from './report/transcript-events.js';

const SINCE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseSince(since: string): number {
  const parsed = SINCE_PATTERN.test(since) ? Date.parse(since) : Number.NaN;
  if (Number.isNaN(parsed))
    throw new HouseError(
      `--since expects a date as YYYY-MM-DD, got "${since}".`,
    );
  return parsed;
}

/** Renders every section of a document, one blank line between sections. */
function renderDocument(document: ReportDocument): string[] {
  const sections = [
    renderTokenUsage(deserializeTokenUsage(document.tokens)),
    renderHookHealth(document.hooks),
    renderGuardEfficacy(document.guard),
    renderSkillAdoption(document.skills),
    renderSkillOutcomes(
      document.outcomes.changesets,
      document.outcomes.ledgers,
    ),
    renderFriction(document.friction),
    renderResidentContext(document.residentContext),
  ];
  return sections.flatMap((section, index) =>
    index === 0 ? section : ['', ...section],
  );
}

function reportImports(paths: string[], flags: Flags): number {
  if (
    flags.since !== undefined ||
    flags.export !== undefined ||
    flags.slug?.length
  )
    throw new HouseError(
      '--since, --export, and --slug do not apply to an import.',
    );
  const documents = readImportFiles(paths);
  if (flags.json) {
    json(documents);
    return 0;
  }
  const labels = documents.map((document) => document.meta.label);
  const [only] = documents;
  if (documents.length === 1 && only) {
    console.log(`\n=== houserules report — import ${only.meta.label} ===\n`);
    console.log(renderDocument(only).join('\n'));
  } else {
    console.log(`\n=== houserules report — ${labels.join(' vs ')} ===\n`);
    console.log(renderComparison(documents).join('\n'));
  }
  console.log('');
  return 0;
}

/**
 * Read-only transcript telemetry with three paths. The live path reads this repo's session
 * logs, including subagent transcripts folded into their parent session, and prints one
 * section per metric family. `--since` drops older sessions, `--label` names the corpus,
 * `--export` also writes a redacted JSON document, and `--json` prints that document
 * instead of text. The import path reads one or more exported files and renders them with
 * the same function as the live path. Two or more files render as a side by side
 * comparison. `--slug` merges extra transcript directories into the live corpus, e.g. a
 * pre-rename history dir.
 *
 * @throws HouseError on a bad `--since`, an unreadable import, or live-only flags beside
 * `--import`.
 */
export async function report(dir: string, flags: Flags): Promise<number> {
  if (flags.import?.length) return reportImports(flags.import, flags);

  const since = flags.since === undefined ? undefined : parseSince(flags.since);
  const root = resolve(dir);
  const ctx = detect(root);
  const top = ctx.git.top ?? root;
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const slugs = [top.replaceAll('/', '-'), ...(flags.slug ?? [])];
  const corpus = readCorpus(join(base, 'projects'), slugs, { since });
  const say = (line: string) => {
    if (!flags.json) console.log(line);
  };

  say(`\n=== houserules report — ${top} ===\n`);
  if (slugs.length > 1) say(`transcript dirs: ${slugs.join(', ')}`);
  if (corpus.skippedBySince > 0)
    say(`(${corpus.skippedBySince} session(s) before ${flags.since} skipped)`);
  if (!corpus.files.length && !flags.json) {
    const dirs = slugs.map((slug) => join(base, 'projects', slug));
    const present = dirs.filter((d) => !corpus.missingDirs.includes(d));
    if (present.length)
      console.log(`No .jsonl transcripts in ${present.join(', ')}.`);
    else console.log(`No transcripts found (looked in ${dirs.join(', ')}).`);
    return 0;
  }
  for (const missing of corpus.missingDirs)
    say(`(no transcripts at ${missing})`);
  for (const unreadable of corpus.unreadableFiles)
    console.error(
      `  (skipped ${unreadable.file}: could not read it — ${unreadable.message})`,
    );

  const document = buildReportDocument(corpus, top, {
    label: flags.label ?? 'local',
    cliVersion: flags.kitVersion,
    since: flags.since,
  });
  if (flags.export !== undefined) {
    writeExportFile(flags.export, redactDocument(document));
    const write = flags.json ? console.error : console.log;
    write(
      `wrote ${flags.export} (${document.meta.sessions} session(s), label ${document.meta.label})`,
    );
  }
  if (flags.json) {
    json(document);
    return 0;
  }
  console.log(renderDocument(document).join('\n'));
  console.log('');
  return 0;
}
