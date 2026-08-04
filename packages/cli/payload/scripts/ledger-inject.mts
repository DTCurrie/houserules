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
import { existsSync, readFileSync } from 'node:fs';

import { loadConfigSafe, repoRoot } from './lib/kit-config.mjs';
import { BACKLOG_ID } from './lib/backlog-id.mjs';
import { readStdinJson } from './lib/proc.mjs';
import { ledgerPath, readLog } from './lib/entry-ledger.mjs';

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

/**
 * One line per ancestor, walking `supersedes` upward and indenting by depth. Titles only,
 * never bodies. A merge has several parents, so this branches rather than following one.
 */
function ancestryLines(
  entries: Map<string, DecisionEntry>,
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

try {
  const input = readStdinJson<PromptPayload>();
  // Claude Code has used both `prompt` and `prompt_text` for this event across
  // versions — accept either so the injector doesn't silently no-op on one build.
  const prompt = String(input?.prompt ?? input?.prompt_text ?? '');
  if (!prompt) process.exit(0);

  const ids = [...new Set(prompt.match(BACKLOG_ID) ?? [])];
  if (!ids.length) process.exit(0);

  const root = repoRoot();
  const ledgerDirName = loadConfigSafe().ledgers?.dir;
  const backlog = projectBacklog(ledgerPath(root, 'backlog', ledgerDirName));
  const { entries: decisions, superseded } = projectDecisions(
    ledgerPath(root, 'decisions', ledgerDirName),
  );

  const blocks: string[] = [];
  for (const id of ids) {
    const b = backlog.get(id);
    if (b) {
      const body = decodeBody(b.content);
      blocks.push(
        `[kit backlog] ${id} — ${b.title ?? '(untitled)'}${b.file ? ` (${b.file})` : ''}\n${body}`.trim(),
      );
      continue;
    }

    const d = decisions.get(id);
    if (!d) continue; // unknown id → inject nothing
    const status = superseded.has(id) ? 'superseded' : 'accepted';
    const body = decodeBody(d.content);
    const ancestry = ancestryLines(decisions, superseded, id);
    const header = `[kit decision] ${id} — ${d.title || '(untitled)'} (${status})${d.file ? ` (${d.file})` : ''}`;
    const parts = [header];
    if (ancestry.length) parts.push(`ancestry:\n${ancestry.join('\n')}`);
    if (body) parts.push(body);
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
