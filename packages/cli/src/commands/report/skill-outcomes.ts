import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadIndex } from '@houserules/payload/ledger-index';
import type { LedgerKind } from '@houserules/payload/ledger-index';

import type { Corpus } from './transcript-events.js';
import { skillFires } from './transcript-events.js';

// A /changeset fire counts as landed when a .changeset file was git-added within this window.
// Wide because the user commits after the session, sometimes days later.
const CHANGESET_MATCH_WINDOW_MS = 72 * 60 * 60 * 1000;

// A ledger-writing skill fire counts as landed when an entry appears within this window,
// used only for entries too old to carry the `chat` session-id field.
const LEDGER_MATCH_WINDOW_MS = 30 * 60 * 1000;

export interface ChangesetOutcome {
  fires: number;
  exact: number;
  windowed: number;
  recordEntries: number;
  filesAdded: number;
}

export interface LedgerOutcome {
  skill: string;
  fires: number;
  matched: number;
  totalAdds: number;
}

interface RecordedEntry {
  ts?: number;
  chat?: string;
  used: boolean;
}

function readRecordedEntries(path: string): RecordedEntry[] {
  const entries: RecordedEntry[] = [];
  if (!existsSync(path)) return entries;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { ts?: string; chat?: string };
      entries.push({
        ts: Date.parse(entry.ts ?? '') || undefined,
        chat: entry.chat,
        used: false,
      });
    } catch {
      // A record line that does not parse is the writer's defect to report, not this
      // function's to throw on.
    }
  }
  return entries;
}

function findMatch(
  entries: RecordedEntry[],
  sessionId: string,
  ts: number | undefined,
): RecordedEntry | undefined {
  return entries.find(
    (candidate) =>
      !candidate.used &&
      (candidate.chat === sessionId ||
        (candidate.ts !== undefined &&
          ts !== undefined &&
          Math.abs(candidate.ts - ts) <= LEDGER_MATCH_WINDOW_MS)),
  );
}

/**
 * A `/changeset` fire landed if the outcome record in `.claude/state/changesets.jsonl` holds
 * an entry from the same session (`chat`, exact) or within the ledger window, each entry
 * matching one fire. Fires older than the record fall back to git history: a `.changeset`
 * file added within the match window, since commit time is the only durable trace once the
 * files are deleted at release.
 */
export function computeChangesetOutcome(
  corpus: Corpus,
  root: string,
): ChangesetOutcome {
  const recorded = readRecordedEntries(
    join(root, '.claude', 'state', 'changesets.jsonl'),
  );
  const log = spawnSync(
    'git',
    [
      'log',
      '--diff-filter=A',
      '--format=COMMIT %ct',
      '--name-only',
      '--',
      '.changeset',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const addTimes: number[] = [];
  let filesAdded = 0;
  let commitMs = 0;
  for (const line of (log.stdout ?? '').split('\n')) {
    if (line.startsWith('COMMIT ')) {
      commitMs = Number(line.slice('COMMIT '.length)) * 1000;
    } else if (line.endsWith('.md') && !line.endsWith('README.md')) {
      filesAdded += 1;
      addTimes.push(commitMs);
    }
  }
  const fires = skillFires(corpus, 'changeset');
  let exact = 0;
  let windowed = 0;
  for (const fire of fires) {
    const record = findMatch(recorded, fire.sessionId, fire.ts);
    if (record) {
      record.used = true;
      exact += 1;
      continue;
    }
    if (
      fire.ts !== undefined &&
      addTimes.some(
        (added) =>
          added >= fire.ts! && added <= fire.ts! + CHANGESET_MATCH_WINDOW_MS,
      )
    )
      windowed += 1;
  }
  return {
    fires: fires.length,
    exact,
    windowed,
    recordEntries: recorded.length,
    filesAdded,
  };
}

const LEDGER_KIND_BY_FILE: Record<string, LedgerKind> = {
  'backlog.jsonl': 'backlog',
  'decisions.jsonl': 'decisions',
};

function readJsonlAdds(path: string): Map<string, RecordedEntry> {
  const adds = new Map<string, RecordedEntry>();
  if (!existsSync(path)) return adds;
  let anonymous = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as {
        action?: string;
        id?: string;
        ts?: string;
        chat?: string;
      };
      if (entry.action !== 'add') continue;
      const key =
        typeof entry.id === 'string' ? entry.id : `anonymous-${anonymous++}`;
      adds.set(key, {
        ts: Date.parse(entry.ts ?? '') || undefined,
        chat: entry.chat,
        used: false,
      });
    } catch {
      // A ledger line that does not parse is someone else's defect to report, not this
      // function's to throw on.
    }
  }
  return adds;
}

/**
 * The `add` entries from the local `.jsonl` plus the synced index, one per `id`. The `.jsonl`
 * entry wins when both hold the same id.
 */
function readLedgerEntries(
  ledgerDirectory: string,
  ledgerFile: string,
): RecordedEntry[] {
  const entries = readJsonlAdds(join(ledgerDirectory, ledgerFile));
  const kind = LEDGER_KIND_BY_FILE[ledgerFile];
  const index = kind ? loadIndex(ledgerDirectory, kind) : null;
  for (const indexed of index?.entries ?? []) {
    if (entries.has(indexed.id)) continue;
    // An index entry carries a date and no time, so its window match is day-granular.
    entries.set(indexed.id, {
      ts: Date.parse(`${indexed.date}T00:00:00.000Z`) || undefined,
      chat: indexed.chat ?? undefined,
      used: false,
    });
  }
  return [...entries.values()];
}

/**
 * A ledger-writing skill fire landed if the ledger holds an `add` entry from the same
 * session (`chat` field, exact) or within the match window (older entries, heuristic). Each
 * entry matches at most one fire.
 */
export function computeLedgerOutcome(
  corpus: Corpus,
  root: string,
  ledgerFile: string,
  skill: string,
): LedgerOutcome {
  const ledgerDirectory = join(root, '.claude', 'ledgers');
  const entries = readLedgerEntries(ledgerDirectory, ledgerFile);
  const fires = skillFires(corpus, skill);
  let matched = 0;
  for (const fire of fires) {
    const entry = findMatch(entries, fire.sessionId, fire.ts);
    if (!entry) continue;
    entry.used = true;
    matched += 1;
  }
  return { skill, fires: fires.length, matched, totalAdds: entries.length };
}

/** The `outcomes:` block, nested under the skills section, so it renders with no header of its own. */
export function renderSkillOutcomes(
  changesets: ChangesetOutcome,
  ledgers: LedgerOutcome[],
): string[] {
  const lines: string[] = ['  outcomes:'];
  lines.push(
    `    /changeset:   fired ${changesets.fires}, matched ${changesets.exact} via the outcome record` +
      ` and ${changesets.windowed} via the 72h git window` +
      ` (${changesets.recordEntries} record entries, ${changesets.filesAdded} files added across history)`,
  );
  for (const outcome of ledgers) {
    lines.push(
      `    /${outcome.skill}:`.padEnd(18) +
        `fired ${outcome.fires}, matched a ledger add for ${outcome.matched}` +
        ` (${outcome.totalAdds} adds in the local ledger)`,
    );
  }
  lines.push(
    '    (ledger counts read the local .jsonl plus the synced index, so they undercount only entries neither holds)',
  );
  return lines;
}
