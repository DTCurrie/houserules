import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { detect } from '../detect.js';
import type { Flags } from '../cli-contract.js';
import { computeFriction, renderFriction } from './report/friction.js';
import {
  computeGuardBlocks,
  renderGuardEfficacy,
} from './report/guard-efficacy.js';
import { computeHookHealth, renderHookHealth } from './report/hook-health.js';
import {
  computeSkillAdoption,
  renderSkillAdoption,
} from './report/skill-adoption.js';
import {
  computeChangesetOutcome,
  computeLedgerOutcome,
  renderSkillOutcomes,
} from './report/skill-outcomes.js';
import { computeTokenUsage, renderTokenUsage } from './report/token-usage.js';
import { readCorpus } from './report/transcript-events.js';

const LEDGERS: [skill: string, ledgerFile: string][] = [
  ['backlog-add', 'backlog.jsonl'],
  ['decide', 'decisions.jsonl'],
];

/**
 * Read-only transcript telemetry. Rolls this repo's session logs into the token tables
 * plus one section per metric family: hook health, guard efficacy, skill adoption and
 * outcomes, and friction. Native `/usage` covers the live view. This is the trend view.
 * `--slug` merges extra transcript directories into the corpus, e.g. a pre-rename
 * history dir.
 */
export async function report(dir: string, flags: Flags): Promise<number> {
  const root = resolve(dir);
  const ctx = detect(root);
  const top = ctx.git.top ?? root;
  const base = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const slugs = [top.replaceAll('/', '-'), ...(flags.slug ?? [])];
  const corpus = readCorpus(join(base, 'projects'), slugs);

  console.log(`\n=== houserules report — ${top} ===\n`);
  if (slugs.length > 1) console.log(`transcript dirs: ${slugs.join(', ')}`);
  if (!corpus.files.length) {
    const dirs = slugs.map((slug) => join(base, 'projects', slug));
    const present = dirs.filter((d) => !corpus.missingDirs.includes(d));
    if (present.length)
      console.log(`No .jsonl transcripts in ${present.join(', ')}.`);
    else console.log(`No transcripts found (looked in ${dirs.join(', ')}).`);
    return 0;
  }
  for (const missing of corpus.missingDirs)
    console.log(`(no transcripts at ${missing})`);

  for (const unreadable of corpus.unreadableFiles)
    console.error(
      `  (skipped ${unreadable.file}: could not read it — ${unreadable.message})`,
    );
  console.log(renderTokenUsage(computeTokenUsage(corpus)).join('\n'));

  console.log('');
  console.log(renderHookHealth(computeHookHealth(corpus)).join('\n'));
  console.log('');
  console.log(renderGuardEfficacy(computeGuardBlocks(corpus)).join('\n'));
  console.log('');
  console.log(
    renderSkillAdoption(
      computeSkillAdoption(corpus, join(top, '.claude', 'skills')),
    ).join('\n'),
  );
  console.log('');
  console.log(
    renderSkillOutcomes(
      computeChangesetOutcome(corpus, top),
      LEDGERS.map(([skill, ledgerFile]) =>
        computeLedgerOutcome(corpus, top, ledgerFile, skill),
      ),
    ).join('\n'),
  );
  console.log('');
  console.log(renderFriction(computeFriction(corpus)).join('\n'));
  console.log('');
  return 0;
}
