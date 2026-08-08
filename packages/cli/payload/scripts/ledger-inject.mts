#!/usr/bin/env node
/**
 * UserPromptSubmit hook. Prints the decoded record for any backlog or decision ID the
 * prompt mentions, which the hook runner adds to the turn's context.
 *
 * Backlog IDs come from the backlog ledger: the latest add/update per id wins, and a
 * remove tombstones the entry so nothing is injected. Decision IDs come from the decision
 * ledger and are never tombstoned. A superseded decision still injects,
 * labelled superseded, with one ancestry line per prior record it descends from.
 *
 * Every failure path exits 0 and prints nothing, because an injector must never block a
 * prompt.
 */

import { gunzipSync } from 'node:zlib';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfigSafe, repoRoot } from './lib/kit-config.mjs';
import { BACKLOG_ID } from './lib/backlog-id.mjs';
import { readStdinJson } from './lib/proc.mjs';
import { ledgerDir, ledgerPath, readLog } from './lib/entry-ledger.mjs';
import {
  loadIndex,
  mergeWithQueue,
  type LedgerEntry,
  type LedgerIndex,
} from './lib/ledger-index.mjs';

interface PromptPayload {
  prompt?: string;
  prompt_text?: string;
}

interface BacklogRecord {
  id?: string;
  action?: string;
  title?: string;
  file?: string;
  content?: string;
}

interface DecisionRecord {
  id?: string;
  action?: string;
  title?: string;
  file?: string;
  supersedes?: string[];
  content?: string;
}

interface DecisionEntry {
  id: string;
  title: string;
  file: string;
  supersedes: string[];
  content: string;
}

function decodeBody(content: string | undefined): string {
  try {
    return content
      ? gunzipSync(Buffer.from(content, 'base64')).toString('utf8')
      : '';
  } catch {
    return '';
  }
}

/** Latest add/update record per id (later lines win); remove tombstones the entry. */
function projectBacklog(logFile: string): Map<string, BacklogRecord> {
  const latest = new Map<string, BacklogRecord>();
  if (!existsSync(logFile)) return latest;
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (!line) continue;
    let r: BacklogRecord;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!r?.id) continue;
    if (r.action === 'remove') latest.delete(r.id);
    else if (r.action === 'add' || r.action === 'update') latest.set(r.id, r);
  }
  return latest;
}

/** Decisions never delete. Status is derived: an id in a later record's `supersedes` is superseded. */
function projectDecisions(logFile: string): {
  entries: Map<string, DecisionEntry>;
  superseded: Set<string>;
} {
  const entries = new Map<string, DecisionEntry>();
  const superseded = new Set<string>();
  for (const r of readLog<DecisionRecord>(logFile)) {
    if (!r?.id) continue;
    if (r.action === 'decide' || r.action === 'supersede') {
      entries.set(r.id, {
        id: r.id,
        title: r.title ?? '',
        file: r.file ?? '',
        supersedes: r.supersedes ?? [],
        content: r.content ?? '',
      });
      for (const target of r.supersedes ?? []) superseded.add(target);
    } else if (r.action === 'amend') {
      const existing = entries.get(r.id);
      if (existing && r.content !== undefined) existing.content = r.content;
    }
  }
  return { entries, superseded };
}

function backlogRecordToEntry(id: string, record: BacklogRecord): LedgerEntry {
  return {
    id,
    itemId: '',
    issue: null,
    title: record.title ?? '',
    body: decodeBody(record.content),
    surface: record.file ?? '',
    date: '',
    chat: null,
    status: null,
    scope: [],
    under: null,
    supersedes: [],
    supersededBy: null,
  };
}

function decisionEntryToLedgerEntry(entry: DecisionEntry): LedgerEntry {
  return {
    id: entry.id,
    itemId: '',
    issue: null,
    title: entry.title,
    body: decodeBody(entry.content),
    surface: entry.file,
    date: '',
    chat: null,
    status: null,
    scope: [],
    under: null,
    supersedes: entry.supersedes,
    supersededBy: null,
  };
}

/**
 * The entries in `ids` resolved against `queued` first and `index` second, queue winning on
 * any id in both, because the queue holds edits the board has not seen yet. An id in neither
 * is left out of the result rather than injecting nothing for it explicitly.
 */
export function resolveEntries(
  ids: readonly string[],
  queued: readonly LedgerEntry[],
  index: LedgerIndex | null,
): Map<string, LedgerEntry> {
  const byId = new Map(mergeWithQueue(index, queued).map((e) => [e.id, e]));
  const resolved = new Map<string, LedgerEntry>();
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry) resolved.set(id, entry);
  }
  return resolved;
}

/**
 * One line per ancestor, walking `supersedes` upward and indenting by depth. Titles only,
 * never bodies. A merge has several parents, so this branches rather than following one.
 */
function ancestryLines(
  entries: Map<string, LedgerEntry>,
  superseded: Set<string>,
  id: string,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>([id]);
  const walk = (fromId: string, depth: number) => {
    for (const ancestorId of entries.get(fromId)?.supersedes ?? []) {
      if (seen.has(ancestorId)) continue;
      seen.add(ancestorId);
      const ancestor = entries.get(ancestorId);
      if (!ancestor) continue;
      const status = superseded.has(ancestorId) ? 'superseded' : 'accepted';
      lines.push(
        `${'  '.repeat(depth)}  ${ancestorId} — ${ancestor.title || '(untitled)'} (${status})`,
      );
      walk(ancestorId, depth + 1);
    }
  };
  walk(id, 0);
  return lines;
}

function main(): void {
  try {
    const input = readStdinJson<PromptPayload>();
    // Claude Code has used both `prompt` and `prompt_text` for this event across
    // versions — accept either so the injector doesn't silently no-op on one build.
    const prompt = String(input?.prompt ?? input?.prompt_text ?? '');
    if (!prompt) {
      process.exit(0);
      return;
    }

    const ids = [...new Set(prompt.match(BACKLOG_ID) ?? [])];
    if (!ids.length) {
      process.exit(0);
      return;
    }

    const root = repoRoot();
    const ledgerDirName = loadConfigSafe().ledgers?.dir;
    const dir = ledgerDir(root, ledgerDirName);

    const backlogQueue = projectBacklog(
      ledgerPath(root, 'backlog', ledgerDirName),
    );
    const { entries: decisionsQueue } = projectDecisions(
      ledgerPath(root, 'decisions', ledgerDirName),
    );

    const backlogQueueEntries = [...backlogQueue].map(([id, r]) =>
      backlogRecordToEntry(id, r),
    );
    const decisionQueueEntries = [...decisionsQueue.values()].map(
      decisionEntryToLedgerEntry,
    );

    const backlogIndex = loadIndex(dir, 'backlog');
    const decisionsIndex = loadIndex(dir, 'decisions');

    const resolvedBacklog = resolveEntries(
      ids,
      backlogQueueEntries,
      backlogIndex,
    );
    const decisions = new Map(
      mergeWithQueue(decisionsIndex, decisionQueueEntries).map((e) => [
        e.id,
        e,
      ]),
    );
    const superseded = new Set<string>();
    for (const entry of decisions.values())
      for (const target of entry.supersedes) superseded.add(target);

    const blocks: string[] = [];
    for (const id of ids) {
      const b = resolvedBacklog.get(id);
      if (b) {
        blocks.push(
          `[kit backlog] ${id} — ${b.title || '(untitled)'}${b.surface ? ` (${b.surface})` : ''}\n${b.body}`.trim(),
        );
        continue;
      }

      const d = decisions.get(id);
      if (!d) continue; // unknown id → inject nothing
      const status = superseded.has(id) ? 'superseded' : 'accepted';
      const ancestry = ancestryLines(decisions, superseded, id);
      const header = `[kit decision] ${id} — ${d.title || '(untitled)'} (${status})${d.surface ? ` (${d.surface})` : ''}`;
      const parts = [header];
      if (ancestry.length) parts.push(`ancestry:\n${ancestry.join('\n')}`);
      if (d.body) parts.push(d.body);
      blocks.push(parts.join('\n\n').trim());
    }

    if (blocks.length)
      process.stdout.write(
        `Referenced ledger item(s), decoded from the kit's logs:\n\n${blocks.join('\n\n')}\n`,
      );
  } catch {
    /* never block a prompt */
  }
  process.exit(0);
}

function isMainModule(): boolean {
  try {
    return (
      !!process.argv[1] &&
      fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}

if (isMainModule()) main();
